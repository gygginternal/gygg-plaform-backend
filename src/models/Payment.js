import mongoose from "mongoose";

// Define the payment schema
const paymentSchema = new mongoose.Schema(
  {
    // Contract related to the payment
    contract: {
      type: mongoose.Schema.ObjectId,
      ref: "Contract",
      required: [true, "A payment must be linked to a contract."],
      unique: true,
    },

    // Gig related to the payment
    gig: {
      type: mongoose.Schema.ObjectId,
      ref: "Gig",
      required: [true, "Payment must be linked to a gig."],
    },

    // Payer: Provider making the payment
    payer: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A payment must have a payer."],
      index: true, // Index to search quickly by payer
    },

    // Payee: Tasker receiving the payment
    payee: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A payment must have a payee."],
      index: true, // Index to search quickly by payee
    },

    // Total payment amount (in cents)
    amount: {
      type: Number,
      required: [true, "Payment amount is required."],
    },

    // Currency used for the payment (defaults to 'CAD')
    currency: {
      type: String,
      required: true,
      default: "cad",
    },

    // Platform's application fee in cents
    applicationFeeAmount: {
      type: Number,
      required: true,
      default: 0, // Default to 0 if not specified
    },

    // Amount actually received by the Tasker (after deducting the platform fee)
    amountReceivedByPayee: {
      type: Number,
      required: true,
    },

    // Status of the payment process
    status: {
      type: String,
      default: "pending_contract",
      required: true,
      index: true, // Index to search quickly by status
    },

    // Type of payment method used (Stripe, Credit Card, etc.)
    paymentMethodType: {
      type: String,
    },

    // --- Stripe Specific Fields ---
    stripePaymentIntentSecret: {
      type: String,
      index: true,
      unique: true,
      sparse: true, // This field might be missing in some payments, so it is sparse.
    },

    stripePayoutId: {
      type: String,
      index: true,
      unique: true,
      sparse: true, // This field might be missing in some payments, so it is sparse.
    },
    stripePaymentIntentId: {
      type: String,
      index: true,
      unique: true,
      sparse: true, // This field might be missing in some payments, so it is sparse.
    },

    stripeChargeId: {
      type: String,
      index: true,
    },

    stripeTransferId: {
      type: String,
      index: true,
      sparse: true, // This field might not exist for all payments
    },

    stripeRefundId: {
      type: String,
      index: true,
    },

    // Tasker's Stripe Connected Account ID
    stripeConnectedAccountId: {
      type: String,
      required: true,
      index: true,
    },

    // --- Timestamps ---
    succeededAt: { type: Date }, // Timestamp for when the payment was successful
    refundedAt: { type: Date }, // Timestamp for when the payment was refunded
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt fields
  }
);

// Pre-save hook to calculate fees and update timestamps when the payment is saved
paymentSchema.pre("save", async function (next) {
  // Calculate platform fee and amount received by Tasker if the amount or status is modified
  if (this.isModified("amount") || this.isNew) {
    // Fetch platform fee percentage from environment variables, default to 0% if not set
    const feePercentage = parseFloat(process.env.PLATFORM_FEE_PERCENT) || 0;

    // Fixed fees value defined
    const fixedFeeCents = 500; // $5.00 in cents
    const percentageFee = Math.round(this.amount * (feePercentage / 100));

    // Calculate application fee (rounded to nearest cent) and amount received by Tasker
    this.applicationFeeAmount = percentageFee + fixedFeeCents;
    this.amountReceivedByPayee = Math.max(
      0,
      this.amount - this.applicationFeeAmount
    );

    // Optional: Log a warning if fee exceeds amount significantly
    if (this.applicationFeeAmount >= this.amount) {
      console.warn(
        `WARNING: Calculated applicationFeeAmount (${this.applicationFeeAmount}) meets or exceeds total amount (${this.amount}) for Payment ${this._id}`
      );
    }
  }

  // Update timestamps for successful or refunded payment status
  if (this.isModified("status")) {
    if (this.status === "succeeded" && !this.succeededAt) {
      this.succeededAt = Date.now();
    } else if (this.status === "refunded" && !this.refundedAt) {
      this.refundedAt = Date.now();
    }
  }

  next(); // Proceed to save the document
});

// Create and export the Payment model based on the schema
const Payment = mongoose.model("Payment", paymentSchema);
export default Payment;
