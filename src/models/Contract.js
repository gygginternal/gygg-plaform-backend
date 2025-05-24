import mongoose from "mongoose";

const contractSchema = new mongoose.Schema(
  {
    gig: {
      type: mongoose.Schema.ObjectId,
      ref: "Gig",
      required: [true, "A contract must be associated with a gig."],
    },
    provider: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A contract must have a provider (gig poster)."],
    },
    tasker: {
      type: mongoose.Schema.ObjectId,
      ref: "User",
      required: [true, "A contract must have a tasker assigned."],
    },
    agreedCost: {
      type: Number,
      required: [true, "A contract must have an agreed cost."],
      min: [0, "Agreed cost cannot be negative."],
    },

    // Status flow of the contract
    status: {
      type: String,
      default: "pending_acceptance",
      required: true,
    },

    terms: {
      type: String,
      trim: true,
    },

    // Timestamp fields related to contract progress
    taskerAcceptedAt: {
      type: Date,
    },
    workSubmittedAt: {
      type: Date,
    },
    providerApprovedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
    cancelledAt: {
      type: Date,
    },
    cancellationReason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
); // Automatically adds createdAt and updatedAt

// Indexes for performance and uniqueness
contractSchema.index({ gig: 1 }, { unique: true }); // Only one contract per gig
contractSchema.index({ provider: 1, status: 1 });
contractSchema.index({ tasker: 1, status: 1 });

// Auto-populate references when querying
contractSchema.pre(/^find/, function (next) {
  this.populate({
    path: "provider",
  })
    .populate({
      path: "tasker",
    })
    .populate({
      path: "gig",
      select: "title status cost",
    });
  next();
});

// Auto-set timestamp fields when status changes
contractSchema.pre("save", function (next) {
  if (this.isModified("status")) {
    const now = Date.now();
    switch (this.status) {
      case "submitted":
        if (!this.workSubmittedAt) this.workSubmittedAt = now;
        break;
      case "approved":
        if (!this.providerApprovedAt) this.providerApprovedAt = now;
        break;
      case "completed":
        if (!this.completedAt) this.completedAt = now;
        break;
      case "cancelled_by_provider":
      case "cancelled_by_tasker":
      case "cancelled_mutual":
        if (!this.cancelledAt) this.cancelledAt = now;
        break;
    }
  }

  // If the contract is new and already in pending_payment (i.e., tasker has accepted)
  if (
    this.isNew &&
    this.status === "pending_payment" &&
    !this.taskerAcceptedAt
  ) {
    this.taskerAcceptedAt = Date.now();
  }

  next();
});

const Contract = mongoose.model("Contract", contractSchema);
export default Contract;
