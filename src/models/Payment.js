import mongoose from "mongoose";

// Define the payment schema
const paymentSchema = new mongoose.Schema(
  {
    // Contract related to the payment (optional for withdrawals)
    contract: {
      type: mongoose.Schema.ObjectId,
      ref: "Contract",
      required: function() { return this.type !== 'withdrawal'; },
      unique: true,
      sparse: true, // Allow null values for withdrawals
    },

    // Gig related to the payment (optional for withdrawals)
    gig: {
      type: mongoose.Schema.ObjectId,
      ref: "Gig",
      required: function() { return this.type !== 'withdrawal'; },
    },

    // Payer: Provider making the payment or user withdrawing
    payer: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A payment must have a payer."],
      index: true, // Index to search quickly by payer
    },

    // Payee: Tasker receiving the payment or user receiving withdrawal
    payee: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A payment must have a payee."],
      index: true, // Index to search quickly by payee
    },

    // Payment type: 'payment' (default) or 'withdrawal'
    type: {
      type: String,
      enum: ['payment', 'withdrawal'],
      default: 'payment',
      required: true,
    },

    // Description for the payment/withdrawal
    description: {
      type: String,
      default: 'Payment for services',
    },

    // Total payment amount (in cents)
    amount: {
      type: Number,
      required: [true, "Payment amount is required."],
    },

    // Currency used for the payment (defaults to 'USD')
    currency: {
      type: String,
      required: true,
      default: "usd",
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

    // Total amount provider pays (service + platform fee + tax)
    totalProviderPayment: {
      type: Number,
      default: 0,
    },

    // Tax amount paid by provider
    providerTaxAmount: {
      type: Number,
      default: 0,
    },

    // Tax amount paid by tasker (deducted from their payment)
    taskerTaxAmount: {
      type: Number,
      default: 0,
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

    // Tax amount (in cents)
    taxAmount: {
      type: Number,
      required: true,
      default: 0,
    },

    // Amount after tax (in cents)
    amountAfterTax: {
      type: Number,
      required: true,
      default: 0,
    },
  },
  {
    timestamps: true, // Automatically manage createdAt and updatedAt fields
  }
);

// Pre-save hook to calculate fees and update timestamps when the payment is saved
paymentSchema.pre("save", async function (next) {
  // Handle withdrawals differently from regular payments
  if (this.type === 'withdrawal') {
    // For withdrawals, set the same values as the amount (no fees/taxes for withdrawals)
    this.amountReceivedByPayee = this.amount;
    this.amountAfterTax = this.amount;
    this.taxAmount = 0;
    this.applicationFeeAmount = 0;
  } else {
    // Only the provider pays the platform fee (fixed + percent) and tax when posting a gig
    // The tasker only pays the tax when withdrawing money (handled at payout, not here)
    if ((this.isModified("amount") || this.isNew) && (this.taxAmount === 0 || this.taxAmount === undefined)) {
      // Use environment variables for fee/tax configuration
      // PLATFORM_FIXED_FEE_CENTS (default 500 = $5), PLATFORM_FEE_PERCENT (default 0.10 = 10%), TAX_PERCENT (default 0.13 = 13%)
      const fixedFeeCents = parseInt(process.env.PLATFORM_FIXED_FEE_CENTS) || 500; // $5.00 in cents
      const feePercentage = parseFloat(process.env.PLATFORM_FEE_PERCENT) || 0.10; // 10%
      const taxPercent = parseFloat(process.env.TAX_PERCENT) || 0.13; // 13%
      // CORRECT PAYMENT BREAKDOWN:
      // Provider pays: Service Amount + Platform Fee + Provider Tax
      // Tasker receives: Service Amount - Tasker Tax
      
      // Service amount (base amount for the service)
      const serviceAmount = this.amount;
      
      // Platform fee (10% + $5 fixed fee) - Provider pays this
      this.applicationFeeAmount = Math.round(serviceAmount * feePercentage) + fixedFeeCents;
      
      // Tax calculations (both provider and tasker pay tax on their portions)
      const providerTaxAmount = Math.round((serviceAmount + this.applicationFeeAmount) * taxPercent); // Tax on service + fee
      const taskerTaxAmount = Math.round(serviceAmount * taxPercent); // Tax on service amount
      
      // Total tax amount (for reporting)
      this.taxAmount = providerTaxAmount + taskerTaxAmount;
      
      // Provider tax (what provider pays)
      this.providerTaxAmount = providerTaxAmount;
      
      // Tasker tax (deducted from tasker's payment)
      this.taskerTaxAmount = taskerTaxAmount;
      
      // Total amount provider pays (service + platform fee + provider tax)
      this.totalProviderPayment = serviceAmount + this.applicationFeeAmount + providerTaxAmount;
      
      // Amount tasker receives (service amount minus tasker tax)
      this.amountReceivedByPayee = serviceAmount - taskerTaxAmount;
      
      // Amount after tax (for legacy compatibility)
      this.amountAfterTax = serviceAmount;
      // Optional: Log a warning if fee exceeds amount significantly
      if (this.applicationFeeAmount >= this.amountAfterTax) {
        console.warn(
          `WARNING: Calculated applicationFeeAmount (${this.applicationFeeAmount}) meets or exceeds total after-tax amount (${this.amountAfterTax}) for Payment ${this._id}`
        );
      }
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
