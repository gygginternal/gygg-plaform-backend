import jwt from "jsonwebtoken";
import crypto from "crypto";
import { promisify } from "util";
import User from "../models/User.js";
import AppError from "../utils/AppError.js";
import catchAsync from "../utils/catchAsync.js";
import sendEmail from "../utils/email.js";
import logger from "../utils/logger.js";
import { stripe } from "./paymentController.js";

/**
 * Signs a JWT token for the given user ID.
 * @param {string} userId - The unique identifier of the user.
 * @returns {string} - The signed JWT token.
 */
const signToken = (userId) => {
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

/**
 * Creates and sends a JWT token in a cookie response.
 * @param {Object} user - The user object.
 * @param {number} statusCode - The HTTP status code for the response.
 * @param {Object} res - The Express response object.
 */
const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);

  const cookieOptions = {
    expires: new Date(
      Date.now() +
        parseInt(process.env.JWT_COOKIE_EXPIRES_IN || "90", 10) *
          24 *
          60 *
          60 *
          1000
    ),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  };

  res.cookie("jwt", token, cookieOptions);

  user.password = undefined;

  // --- Check for onboarding redirection ---
  let redirectToOnboardingPath = null;
  if (user.role.includes("tasker") && !user.isTaskerOnboardingComplete) {
    redirectToOnboardingPath = "/onboarding/tasker"; // Frontend route for tasker onboarding
  }
  // Example: Add a similar check for providers if you have provider-specific onboarding
  else if (
    user.role.includes("provider") &&
    !user.isProviderOnboardingComplete
  ) {
    redirectToOnboardingPath = "/onboarding/provider";
  }

  res.status(statusCode).json({
    status: "success",
    token,
    data: {
      user,
      redirectToOnboarding: redirectToOnboardingPath, // Send this to the frontend
    },
  });
};

/**
 * Sends email verification to the user.
 */
const sendVerificationEmail = async (user, req) => {
  const verificationToken = user.createEmailVerificationToken();
  await user.save({ validateBeforeSave: false });

  const verificationURL = `${req.protocol}://${req.get(
    "host"
  )}/api/v1/users/verifyEmail/${verificationToken}`;
  const message = `Welcome to Gig Platform! Please verify your email:\n\n${verificationURL}\n\nThis link will expire in 10 minutes.`;

  try {
    await sendEmail({
      email: user.email,
      subject: "Gig Platform - Verify Your Email Address",
      message,
    });
    logger.info(`Verification email sent to ${user.email}`);
  } catch (error) {
    logger.error(`Failed to send verification email to ${user.email}`, {
      error,
    });
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save({ validateBeforeSave: false });
  }
};

/**
 * Handles user signup functionality.
 * @route POST /api/v1/auth/signup
 * @access Public
 */
export const signup = catchAsync(async (req, res, next) => {
  const {
    firstName,
    lastName,
    email,
    password,
    passwordConfirm,
    role,
    phoneNo,
  } = req.body;

  const allowedRoles = ["tasker", "provider"];
  const finalRoles = Array.isArray(role)
    ? role.filter((r) => allowedRoles.includes(r))
    : ["tasker"];

  if (finalRoles.length === 0) {
    return next(
      new AppError("Invalid role. Choose either tasker or provider.", 400)
    );
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: "CA",
    email: email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_type: "individual",
  });

  const newUser = await User.create({
    firstName,
    lastName,
    email,
    password,
    passwordConfirm,
    role: finalRoles,
    phoneNo,
    stripeAccountId: account.id,
  });

  try {
    await sendVerificationEmail(newUser, req);
  } catch (emailError) {
    logger.warn(
      `Signup completed for ${newUser.email}, but verification email failed.`
    );
  }

  createSendToken(newUser, 201, res);
});

/**
 * Handles user login functionality.
 * @route POST /api/v1/auth/login
 * @access Public
 */
export const login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return next(new AppError("Please provide email and password!", 400));
  }

  // Select onboarding flags along with password
  const user = await User.findOne({ email }).select(
    "+password +isTaskerOnboardingComplete +isProviderOnboardingComplete"
  );

  if (!user || !(await user.correctPassword(password, user.password))) {
    logger.warn(
      `Login attempt failed for email: ${email} (Incorrect credentials)`
    );
    return next(new AppError("Incorrect email or password", 401));
  }

  if (!user.isEmailVerified) {
    logger.warn(`Login attempt by unverified user: ${user.email}`);
    return next(
      new AppError(
        "Please verify your email address before logging in. Check your inbox for the verification link.",
        403
      )
    );
  }

  logger.info(`User logged in successfully: ${user.email}`);
  // createSendToken now handles sending the token, user data, AND the onboarding redirect signal
  createSendToken(user, 200, res);
});

/**
 * Logs the user out by clearing the JWT cookie.
 * @route GET /api/v1/auth/logout
 * @access Public
 */
export const logout = (req, res) => {
  res.cookie("jwt", "loggedout", {
    expires: new Date(Date.now() + 5 * 1000),
    httpOnly: true,
  });
  res.status(200).json({ status: "success" });
};

/**
 * Protects routes and ensures the user is authenticated.
 * @route Middleware
 * @access Private
 */
export const protect = catchAsync(async (req, res, next) => {
  let token;

  if (req.headers.authorization?.startsWith("Bearer")) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  }

  if (!token || token === "loggedout") {
    return next(new AppError("You are not logged in!", 401));
  }

  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  const currentUser = await User.findById(decoded.id).select(
    "+passwordChangedAt"
  );
  if (!currentUser) {
    return next(new AppError("User no longer exists.", 401));
  }

  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError("Password changed recently. Please log in again.", 401)
    );
  }

  req.user = currentUser;
  res.locals.user = currentUser;
  next();
});

/**
 * Restricts access to specific roles.
 */
export const restrictTo = (...allowedRoles) => {
  return (req, res, next) => {
    const userRoles = req.user.role || [];
    console.log({ userRoles, allowedRoles });

    const hasAccess = userRoles.some((role) => allowedRoles.includes(role));
    console.log({ hasAccess });

    if (!hasAccess) {
      return next(
        new AppError("You do not have permission for this action.", 403)
      );
    }
    next();
  };
};

/**
 * Verifies the user's email using the token.
 * @route GET /api/v1/users/verifyEmail/:token
 */
export const verifyEmail = catchAsync(async (req, res, next) => {
  const hashedToken = crypto
    .createHash("sha256")
    .update(req.params.token)
    .digest("hex");

  const user = await User.findOne({
    emailVerificationToken: hashedToken,
    emailVerificationExpires: { $gt: Date.now() },
  });

  if (!user) {
    logger.warn("Email verification failed: Invalid or expired token.", {
      tokenAttempt: req.params.token,
    });
    return next(new AppError("Token is invalid or has expired.", 400));
  }

  user.isEmailVerified = true;
  user.emailVerificationToken = undefined;
  user.emailVerificationExpires = undefined;
  await user.save();

  logger.info(`Email verified successfully for user ${user._id}`);

  res.status(200).json({
    status: "success",
    message: "Email verified successfully! You can now log in.",
  });
});

/**
 * Resends the email verification token to the user.
 * @route POST /api/v1/users/resendVerification
 */
export const resendVerificationEmail = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id);

  if (!user) {
    return next(new AppError("User not found.", 404));
  }

  if (user.isEmailVerified) {
    return next(new AppError("Your email is already verified.", 400));
  }

  await sendVerificationEmail(user, req);

  res.status(200).json({
    status: "success",
    message: "Verification email resent. Please check your inbox.",
  });
});

export const updatePassword = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id).select("+password");
  const { passwordCurrent, password, passwordConfirm } = req.body;

  if (
    !passwordCurrent ||
    !(await user.correctPassword(passwordCurrent, user.password))
  ) {
    return next(new AppError("Your current password is incorrect", 401));
  }

  // Mongoose validation for passwordConfirm runs automatically if passwordConfirm is in schema
  // and the schema validator is correctly defined.
  user.password = password;
  user.passwordConfirm = passwordConfirm; // Schema validator will check if it matches user.password
  await user.save(); // Use save() to trigger pre-save middleware (hashing, passwordChangedAt)

  // Log user in, send JWT
  createSendToken(user, 200, res);
});
