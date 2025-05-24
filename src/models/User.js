// models/User.js

import mongoose from "mongoose";
import validator from "validator";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import logger from "../utils/logger.js";

// ---------------- Address Schema ---------------- //
const addressSchema = new mongoose.Schema(
  {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  { _id: false }
);

// ---------------- Availability Schema ---------------- //
const availabilitySchema = new mongoose.Schema(
  {
    monday: { type: Boolean, default: true },
    tuesday: { type: Boolean, default: true },
    wednesday: { type: Boolean, default: true },
    thursday: { type: Boolean, default: true },
    friday: { type: Boolean, default: true },
    saturday: { type: Boolean, default: false },
    sunday: { type: Boolean, default: false },
  },
  { _id: false }
);

const albumPhotoSchema = new mongoose.Schema(
  {
    url: { type: String, required: true }, // S3 Object URL (or CloudFront URL)
    key: { type: String, required: true, select: false }, // <<< S3 Object Key (needed for deletion)
    caption: { type: String, trim: true, maxlength: 50 },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// ---------------- User Schema ---------------- //
const userSchema = new mongoose.Schema(
  {
    // Basic Info
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      validate: [validator.isEmail, "Please provide a valid email"],
    },
    phoneNo: {
      type: String,
      validate: {
        validator: (v) => validator.isMobilePhone(v),
        message: (props) => `${props.value} is not a valid phone number!`,
      },
    },

    // Authentication
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: 8,
      select: false,
    },
    passwordConfirm: {
      type: String,
      // required: [true, 'Please confirm your password'],
      validate: {
        validator: function (el) {
          if (!this.isModified("password") && !this.isNew) return true;
          return el === this.password;
        },
        message: "Passwords do not match",
      },
    },
    passwordChangedAt: {
      type: Date,
      select: false,
    },
    passwordResetToken: String,
    passwordResetExpires: Date,

    // Role-based Access
    role: {
      type: [String],
      enum: ["tasker", "provider", "admin"],
      required: [true, "At least one role is required"],
    },

    profileImage: { type: String, default: "default.jpg" }, // Store S3/CloudFront URL
    profileImageKey: { type: String, select: false }, // <<< Renamed field for S3 Key
    album: [albumPhotoSchema],

    // Profile Details
    address: addressSchema,
    bio: {
      type: String,
      trim: true,
      maxlength: [500, "Bio cannot be more than 500 characters"],
    },
    profileImage: {
      type: String,
      default: "default.jpg",
    },
    hobbies: [{ type: String, trim: true }],
    skills: [{ type: String, trim: true }],
    peoplePreference: [
      {
        type: String,
        trim: true,
        maxlength: [
          300,
          "People preference cannot be more than 300 characters",
        ],
      },
    ],

    // Availability and Rate
    availability: {
      type: availabilitySchema,
      default: () => ({}),
    },
    ratePerHour: {
      type: Number,
      default: 0,
    },

    // Ratings
    rating: {
      type: Number,
      default: 0,
      min: [0, "Rating must be at least 0"],
      max: [5, "Rating cannot be more than 5"],
    },
    ratingCount: {
      type: Number,
      default: 0,
    },

    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationToken: String,
    emailVerificationExpires: Date,

    // Stripe Connect Integration
    stripeAccountId: {
      type: String,
    },
    stripeChargesEnabled: {
      type: Boolean,
      default: false,
      select: false,
    },
    stripePayoutsEnabled: {
      type: Boolean,
      default: false,
      select: false,
    },

    // Account Status
    active: {
      type: Boolean,
      default: true,
      select: false,
    },

    // Onboarding Completion Flags
    isTaskerOnboardingComplete: {
      type: Boolean,
      default: false,
      select: true, // Select this by default so login can check it
    },
    // Example for provider:
    isProviderOnboardingComplete: {
      type: Boolean,
      default: false,
      select: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ---------------- Virtuals ---------------- //
userSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// ---------------- Indexes ---------------- //
userSchema.index({ stripeAccountId: 1 });

// ---------------- Document Middleware ---------------- //

// Encrypt password before saving
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  this.passwordConfirm = undefined; // Remove confirm field
  next();
});

// Set passwordChangedAt if password is modified
userSchema.pre("save", function (next) {
  if (!this.isModified("password") || this.isNew) return next();
  this.passwordChangedAt = Date.now() - 1000;
  next();
});

// ---------------- Query Middleware ---------------- //

// Exclude inactive users from all find queries
userSchema.pre(/^find/, function (next) {
  this.find({ active: { $ne: false } });
  next();
});

// ---------------- Instance Methods ---------------- //

// Check if provided password is correct
userSchema.methods.correctPassword = async function (
  candidatePassword,
  userPassword
) {
  return await bcrypt.compare(candidatePassword, userPassword);
};

// Check if user changed password after JWT was issued
userSchema.methods.changedPasswordAfter = function (JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(
      this.passwordChangedAt.getTime() / 1000,
      10
    );
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

// ---------------- Text Index for Search ---------------- //
userSchema.index(
  { peoplePreference: "text", bio: "text" },
  {
    weights: { peoplePreference: 10, bio: 5 },
    name: "TextSearchIndex",
  }
);

// --- Method to generate email verification token ---
userSchema.methods.createEmailVerificationToken = function () {
  const verificationToken = crypto.randomBytes(32).toString("hex");

  this.emailVerificationToken = crypto
    .createHash("sha256")
    .update(verificationToken)
    .digest("hex");

  this.emailVerificationExpires = Date.now() + 10 * 60 * 1000; // Token expires in 10 minutes

  logger.debug(
    `Generated email verification token (raw): ${verificationToken} for user ${this._id}`
  );
  return verificationToken; // Return the unhashed token to send via email
};

// ---------------- Export ---------------- //
const User = mongoose.model("User", userSchema);
export default User;
