import Stripe from "stripe";
import Payment from "../models/Payment.js";
import Contract from "../models/Contract.js";
import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import mongoose from "mongoose";

// Initialize Stripe with the secret key from environment variables
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const checkIfContractIsReleasable = catchAsync(
  async (req, res, next) => {
    const { contractId } = req.params;

    // Retrieve the payment record from the database
    const payment = await Payment.findOne({ contract: contractId }).populate(
      "payee"
    );

    if (!payment) {
      return next(new AppError("Payment not found for this contract.", 404));
    }

    // Check if the payment status is valid for release
    const isPayoutReady = payment.status === "succeeded";

    // Retrieve the available balance from Stripe
    const balance = await stripe.balance.retrieve({
      stripeAccount: payment.payee.stripeAccountId,
    });
    console.log(JSON.stringify({ balance }, null, 2));

    const available = balance.available.find(
      (b) => b.currency === payment.currency
    );
    const payoutAvailable = available ? available.amount : 0;

    // Check if the available balance is sufficient
    const isBalanceSufficient =
      payoutAvailable >= payment.amountReceivedByPayee;

    // Determine if the contract is releasable
    const isReleasable = isPayoutReady && isBalanceSufficient;

    res.status(200).json({
      status: "success",
      data: {
        isReleasable,
        isPayoutReady,
        isBalanceSufficient,
        payoutAvailable: (payoutAvailable / 100).toFixed(2),
        requiredAmount: (payment.amountReceivedByPayee / 100).toFixed(2),
        currency: payment.currency.toUpperCase(),
      },
    });
  }
);

export const createStripeLoginLink = catchAsync(async (req, res, next) => {
  const tasker = req.user;

  // Ensure the tasker has a Stripe account ID
  if (!tasker.stripeAccountId) {
    return next(
      new AppError("You do not have a connected Stripe account.", 400)
    );
  }

  // Generate a login link for the tasker's Stripe Express account
  const loginLink = await stripe.accounts.createLoginLink(
    tasker.stripeAccountId
  );

  if (!loginLink || !loginLink.url) {
    return next(new AppError("Failed to generate Stripe login link.", 500));
  }

  res.status(200).json({
    status: "success",
    data: {
      loginLink: loginLink.url,
    },
  });
});

export const getPaymentIntentForContract = catchAsync(
  async (req, res, next) => {
    const { contractId } = req.params;

    // Retrieve the payment intent from the database or payment provider (e.g., Stripe)
    const payment = await Payment.findOne({ contract: contractId });
    console.log({ payment });

    if (!payment) {
      return next(new AppError("Payment not found for this contract.", 404));
    }

    let paymentIntent;
    if (payment.stripePaymentIntentId) {
      paymentIntent = await stripe.paymentIntents.retrieve(
        payment.stripePaymentIntentId
      );
    }

    if (!paymentIntent) {
      return next(
        new AppError("Payment intent not found for this contract.", 404)
      );
    }

    res.status(200).json({
      status: "success",
      data: {
        paymentIntent,
        payment,
      },
    });
  }
);

export const releasePaymentForContract = catchAsync(async (req, res, next) => {
  const { contractId } = req.params;

  // Retrieve the payment details for the contract
  const payment = await Payment.findOne({ contract: contractId }).populate(
    "payee"
  );

  if (!payment) {
    return next(new AppError("Payment not found for this contract.", 404));
  }

  // Create a payout using the payment details
  const acc = await stripe.accounts.retrieve(payment.payee.stripeAccountId);
  console.log({ acc });

  const payout = await stripe.payouts.create(
    {
      amount: payment.amount,
      currency: payment.currency,
    },
    {
      stripeAccount: payment.payee.stripeAccountId,
    }
  );

  // Update the payment status to "released"
  payment.status = payout.status;
  payment.stripePayoutId = payout.id;

  await payment.save();

  res.status(200).json({
    status: "success",
    message: "Payment released successfully.",
    data: {
      payout,
    },
  });
});

// --- Create Payment Intent for Contract (Provider -> Tasker via Platform) ---
export const createPaymentIntentForContract = catchAsync(
  async (req, res, next) => {
    const { contractId } = req.params;
    const providerId = req.user.id;

    // Check if the contractId is valid
    if (!mongoose.Types.ObjectId.isValid(contractId))
      return next(new AppError("Invalid Contract ID format.", 400));

    // Fetch the contract along with the tasker details
    const contract = await Contract.findById(contractId);

    if (!contract) return next(new AppError("Contract not found.", 404));

    // Check if the provider is authorized to make the payment

    if (contract.provider._id.toString() !== providerId)
      return next(
        new AppError("Not authorized to pay for this contract.", 403)
      );

    // Ensure that the contract is in a valid status for payment
    if (
      !["pending_payment", "failed"].includes(contract.status) &&
      contract.status !== "pending_contract"
    ) {
      return next(
        new AppError(
          `Contract not awaiting payment (status: ${contract.status}).`,
          400
        )
      );
    }

    // Ensure that the tasker has connected a valid Stripe account and has enabled payouts

    if (!contract.tasker?.stripeAccountId)
      return next(new AppError("Tasker has not connected Stripe.", 400));
    // if (!contract.tasker?.stripePayoutsEnabled)
    //   return next(
    //     new AppError(
    //       "Tasker Stripe onboarding incomplete or payouts disabled.",
    //       400
    //     )
    //   );

    const taskerStripeAccountId = contract.tasker.stripeAccountId;
    const amountInCents = Math.round(contract.agreedCost * 100); // Total amount provider pays
    if (amountInCents <= 0)
      return next(new AppError("Invalid contract cost.", 400));

    // Calculate the application fee based on the platform's percentage and fixed fee
    const feePercentage = parseFloat(process.env.PLATFORM_FEE_PERCENT) || 0;
    const fixedFeeCents = 0; // Define the fixed fee ($5.00) in cents

    // Calculate percentage part
    const percentageFee = Math.round(amountInCents * (feePercentage / 100));

    // Calculate total application fee
    const applicationFeeAmount = percentageFee + fixedFeeCents;

    // Optional: Sanity check - ensure fee doesn't exceed total amount
    if (applicationFeeAmount >= amountInCents) {
      console.error(
        `Calculated fee (${applicationFeeAmount}) exceeds or equals total amount (${amountInCents}) for Contract ${contractId}.`
      );
      // Decide how to handle: error out, or maybe cap fee at amount - 1 cent?
      return next(
        new AppError(
          "Platform fee calculation error. Please contact support.",
          500
        )
      );
    }

    const paymentCurrency = "cad";

    // Check if there's an existing payment record for the contract
    let payment = await Payment.findOne({ contract: contractId });
    if (!payment) {
      // If no payment record exists, create a new one
      payment = await Payment.create({
        contract: contractId,
        gig: contract.gig,
        payer: providerId,
        payee: contract.tasker._id,
        amount: amountInCents,
        currency: paymentCurrency,
        status: "requires_payment_method",
        stripeConnectedAccountId: taskerStripeAccountId,
        applicationFeeAmount: applicationFeeAmount,
        amountReceivedByPayee: amountInCents - applicationFeeAmount,
      });
    } else if (
      !["requires_payment_method", "failed"].includes(payment.status)
    ) {
      // If payment is already in another status, reject the operation
      return next(
        new AppError(`Payment already in status: ${payment.status}`, 400)
      );
    } else {
      // Update payment if retrying
      payment.amount = amountInCents;
      payment.currency = paymentCurrency;
      payment.stripeConnectedAccountId = taskerStripeAccountId;
      payment.applicationFeeAmount = applicationFeeAmount;
      payment.status = "requires_payment_method";
      await payment.save();
    }

    // Define the parameters for the payment intent
    const paymentIntentParams = {
      amount: amountInCents,
      currency: payment.currency,
      automatic_payment_methods: { enabled: true },
      capture_method: "automatic",
      application_fee_amount: payment.applicationFeeAmount,
      transfer_data: { destination: taskerStripeAccountId },
      metadata: {
        paymentId: payment._id.toString(),
        contractId: contractId.toString(),
        providerId: providerId.toString(),
        taskerId: contract.tasker._id.toString(),
      },
    };

    // Attempt to update or create the payment intent
    let paymentIntent;
    if (payment.stripePaymentIntentId) {
      try {
        paymentIntent = await stripe.paymentIntents.update(
          payment.stripePaymentIntentId,
          {
            amount: amountInCents,
            application_fee_amount: payment.applicationFeeAmount,
            transfer_data: paymentIntentParams.transfer_data,
            metadata: paymentIntentParams.metadata,
          }
        );
      } catch (error) {
        if (
          error.code === "payment_intent_unexpected_state" ||
          error.code === "resource_missing"
        ) {
          // If an error occurs, create a new payment intent
          paymentIntent = await stripe.paymentIntents.create(
            paymentIntentParams
          );
          payment.stripePaymentIntentId = paymentIntent.id;
        } else {
          throw error;
        }
      }
    } else {
      // If there's no existing payment intent, create one
      paymentIntent = await stripe.paymentIntents.create(paymentIntentParams);
      console.log({ paymentIntent });

      payment.stripePaymentIntentId = paymentIntent.id;
      payment.stripePaymentIntentSecret = paymentIntent.client_secret;
    }

    // Save payment with the payment intent ID
    payment.status = "requires_payment_method";
    await payment.save();

    // Respond with the client secret to complete the payment
    res.status(200).json({
      status: "success",
      clientSecret: paymentIntent.client_secret,
      paymentId: payment._id,
    });
  }
);

const handlePayoutPaid = async (dataObject) => {
  try {
    // Retrieve the payout ID from the event data
    const payoutId = dataObject.id;

    // Find the payment record associated with this payout
    const payment = await Payment.findOne({ stripePayoutId: payoutId });

    if (!payment) {
      console.error(`❌ Payment record not found for payout ID: ${payoutId}`);
      return;
    }

    // Update the payment status to "succeeded"
    payment.status = "succeeded";
    await payment.save();

    console.log(
      `✅ Payment status updated to "succeeded" for payout ID: ${payoutId}`
    );
  } catch (error) {
    console.error(`❌ Error handling payout.paid event: ${error.message}`);
  }
};

// --- Stripe Webhook Handler ---
export const stripeWebhookHandler = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;

  // Verify the webhook signature
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error(`❌ Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const dataObject = event.data.object;

  // Handle different event types from Stripe
  switch (event.type) {
    case "payout.paid": // Handle payout.paid event
      await handlePayoutPaid(dataObject);
      break;
    default:
      // Log and ignore unhandled events
      break;
  }

  // Respond to Stripe to confirm receipt of the webhook
  res.status(200).json({ received: true });
};

// --- Initiate Refund for Contract ---
export const refundPaymentForContract = catchAsync(async (req, res, next) => {
  const { contractId } = req.params;
  if (!mongoose.Types.ObjectId.isValid(contractId))
    return next(new AppError("Invalid Contract ID format.", 400));

  const contract = await Contract.findById(contractId);
  if (!contract) return next(new AppError("Contract not found", 404));

  const payment = await Payment.findOne({ contract: contractId });
  if (!payment) return next(new AppError("Payment record not found", 404));
  // if (payment.status !== "succeeded")
  //   return next(
  //     new AppError(`Cannot refund payment with status: ${payment.status}`, 400)
  //   );
  if (!payment.stripePaymentIntentId)
    return next(new AppError("Cannot refund: Missing Payment Intent ID.", 500));

  const paymentIntent = await stripe.paymentIntents.retrieve(
    payment.stripePaymentIntentId,
    {
      expand: ["charges"],
    }
  );
  console.log({ paymentIntent });

  const chargeId = paymentIntent.latest_charge;
  try {
    // Initiate the refund via Stripe
    const refund = await stripe.refunds.create({
      charge: chargeId,
    });
    console.log(
      `Stripe Refund created: ${refund.id}, Status: ${refund.status}`
    );

    // Update payment and contract status
    payment.status = "refund_pending";
    payment.stripeRefundId = refund.id;
    await payment.save();
    contract.status = "cancelled";
    await contract.save();

    res.status(200).json({
      status: "success",
      message: "Refund initiated successfully.",
      refundId: refund.id,
    });
  } catch (error) {
    console.error(
      `❌ Error creating Stripe Refund for Charge ${payment.stripeChargeId}:`,
      error
    );
    return next(
      new AppError(`Failed to initiate refund: ${error.message}.`, 500)
    );
  }
});

// --- Create Stripe Account for User ---
export const createStripeAccount = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id);
  if (!user) return next(new AppError("User not found.", 404));

  // If user already has a Stripe account, proceed to create the account link
  if (user.stripeAccountId) {
    return createStripeAccountLink(req, res, next);
  }

  try {
    // Create a new Stripe Express account
    const account = await stripe.accounts.create({
      type: "express",
      country: "CA",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "individual",
      settings: {
        payouts: {
          schedule: {
            interval: "manual", // Platform will trigger payouts manually
          },
        },
      },
    });

    user.stripeAccountId = account.id;
    await user.save({ validateBeforeSave: false });
    return createStripeAccountLink(req, res, next);
  } catch (error) {
    console.error("Error creating Stripe account:", error);
    return next(new AppError("Could not create Stripe account.", 500));
  }
});

// --- Generate Stripe Account Onboarding Link ---
export const createStripeAccountLink = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id).select("+stripeAccountId");

  if (!user || !user.stripeAccountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: "CA",
      email: user.email,
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      business_type: "individual",
      settings: {
        payouts: {
          schedule: {
            interval: "manual", // Platform will trigger payouts manually
          },
        },
      },
    });

    user.stripeAccountId = account.id;
    await user.save();
  }

  try {
    // Create the Stripe account link for onboarding
    const accountLink = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: `${process.env.FRONTEND_URL}/stripe-onboarding/refresh`,
      return_url: `${process.env.FRONTEND_URL}/stripe-onboarding/return`,
      type: "account_onboarding",
    });

    res.status(200).json({ status: "success", url: accountLink.url });
  } catch (error) {
    console.error(
      `Error creating Account Link for ${user.stripeAccountId}:`,
      error
    );
    return next(new AppError("Could not create onboarding link.", 500));
  }
});

// --- Get Stripe Account Status ---
export const getStripeAccountStatus = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id).select("+stripeAccountId");
  if (!user || !user.stripeAccountId)
    return next(new AppError("Stripe account not found for user.", 400));

  try {
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    res.status(200).json({
      account,
      status: "success",
      payoutsEnabled: account.payouts_enabled,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.capabilities.card_payments === "active",
      stripeAccountStatus:
        account.capabilities.transfers === "active" ? "active" : "incomplete",
    });
  } catch (error) {
    console.error(
      `Error retrieving Stripe account ${user.stripeAccountId}:`,
      error
    );
    return next(new AppError("Could not retrieve account status.", 500));
  }
});
