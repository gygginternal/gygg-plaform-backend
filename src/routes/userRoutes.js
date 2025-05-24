// src/routes/userRoutes.js
import express from "express";
import { body, param, query } from "express-validator";
import validateRequest from "../middleware/validateRequest.js";

import {
  signup,
  login,
  protect,
  restrictTo,
  updatePassword,
  logout,
  verifyEmail,
  resendVerificationEmail,
} from "../controllers/authController.js";

// Ensure ALL needed functions are imported from userController
import {
  getMe,
  updateMe,
  deleteMe,
  getAllUsers,
  getUser,
  updateUser,
  deleteUser, // Admin functions
  matchTaskers,
  uploadAlbumPhoto,
  getUserAlbum,
  deleteAlbumPhoto,
} from "../controllers/userController.js";

import {
  createStripeAccount,
  createStripeAccountLink,
  getStripeAccountStatus,
  createStripeLoginLink, // Import the new controller function
} from "../controllers/paymentController.js";

import { uploadS3 } from "../config/s3Config.js"; // S3 Upload middleware
import { parseJsonFields } from "../middleware/parseFormData.js";

const router = express.Router();

/**
 * ===============================
 *        AUTHENTICATION & VERIFICATION
 * ===============================
 */
const signupValidation = [
  body("firstName")
    .notEmpty()
    .withMessage("First name is required")
    .trim()
    .escape(),
  body("lastName")
    .notEmpty()
    .withMessage("Last name is required")
    .trim()
    .escape(),
  body("email")
    .isEmail()
    .withMessage("Please provide a valid email")
    .normalizeEmail(),
  body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters"),
  body("passwordConfirm")
    .notEmpty()
    .withMessage("Please confirm your password")
    .custom((value, { req }) => {
      if (value !== req.body.password)
        throw new Error("Passwords do not match");
      return true;
    }),
  body("role").optional().isArray().withMessage("Role must be an array"),
  body("role.*")
    .isIn(["tasker", "provider"])
    .withMessage("Invalid role specified"),
  body("phoneNo")
    .optional({ checkFalsy: true })
    .isMobilePhone("any", { strictMode: false })
    .withMessage("Invalid phone number format"),
];
router.post("/signup", signupValidation, validateRequest, signup);

const loginValidation = [
  body("email").isEmail().withMessage("Valid email required").normalizeEmail(),
  body("password").notEmpty().withMessage("Password required"),
];
router.post("/login", loginValidation, validateRequest, login);

router.get("/logout", logout); // No input validation needed

// Email verification token comes from email link, format checked by controller
router.get("/verifyEmail/:token", verifyEmail);

/**
 * ===============================
 *      PASSWORD & PROFILE (Protected)
 * ===============================
 */
router.use(protect); // All routes below require authentication

router.post("/resendVerificationEmail", resendVerificationEmail); // No body validation needed

const updatePasswordValidation = [
  body("passwordCurrent")
    .notEmpty()
    .withMessage("Current password is required"),
  body("password")
    .isLength({ min: 8 })
    .withMessage("New password must be at least 8 characters"),
  body("passwordConfirm").custom((value, { req }) => {
    if (value !== req.body.password)
      throw new Error("New passwords do not match");
    return true;
  }),
];
router.patch(
  "/updateMyPassword",
  updatePasswordValidation,
  validateRequest,
  updatePassword
);

router.get("/me", getMe, getUser); // getMe sets req.params.id for getUser

const updateMeValidation = [
  // uploadS3.single('profileImage'), // Add this middleware IF you handle profile image upload on this route
  body("firstName").optional().trim().escape(),
  body("lastName").optional().trim().escape(),
  // Email changes should be handled with re-verification, generally not in a simple updateMe
  // body('email').optional().isEmail().normalizeEmail(),
  body("phoneNo")
    .optional({ checkFalsy: true })
    .isMobilePhone("any", { strictMode: false })
    .withMessage("Invalid phone number"),
  body("bio").optional().trim().escape().isLength({ max: 500 }),
  body("hobbies").optional().isArray().withMessage("Hobbies must be an array"),
  body("hobbies.*").optional().isString().trim().escape(),
  body("skills").optional().isArray().withMessage("Skills must be an array"), // If 'skills' field added to User model
  body("skills.*").optional().isString().trim().escape(),
  body("peoplePreference").optional().trim().escape().isLength({ max: 300 }),
  body("availability")
    .optional()
    .isObject()
    .withMessage("Availability must be an object"),
  // Nested validation for availability (example)
  body("availability.monday").optional().isBoolean().toBoolean(),
  // ... add for other days ...
  body("ratePerHour").optional().isNumeric().toFloat({ min: 0.0 }),
  // Address validation
  body("address").optional().isObject(),
  body("address.street").optional({ checkFalsy: true }).trim().escape(),
  body("address.city").optional({ checkFalsy: true }).trim().escape(),
  body("address.state").optional({ checkFalsy: true }).trim().escape(),
  body("address.postalCode").optional({ checkFalsy: true }).trim().escape(),
  body("address.country").optional({ checkFalsy: true }).trim().escape(),
  // Prevent password update attempts on this route
  body("password")
    .not()
    .exists()
    .withMessage("Password updates not allowed here."),
  body("passwordConfirm").not().exists(),
];
router.patch(
  "/updateMe",
  uploadS3.single("profileImage"), // Place Multer middleware BEFORE validation if it affects req.body
  parseJsonFields(["availability"]),
  updateMeValidation,
  validateRequest,
  updateMe
);

router.delete("/deleteMe", deleteMe); // No input validation for this specific action

/**
 * ===============================
 *         USER ALBUM (Protected, relative to /me)
 * ===============================
 */
router
  .route("/me/album")
  .get(getUserAlbum) // No specific params/body to validate beyond auth
  .post(
    uploadS3.single("albumImage"), // Multer middleware for S3 upload, fieldname 'albumImage'
    [
      body("caption")
        .trim()
        .notEmpty()
        .withMessage("Caption is required.")
        .isLength({ max: 50 })
        .escape(),
    ],
    validateRequest,
    uploadAlbumPhoto
  );

router.delete(
  "/me/album/:photoId",
  [param("photoId").isMongoId().withMessage("Invalid photo ID format")],
  validateRequest,
  deleteAlbumPhoto
);

// Route to view *another* user's public album (if needed)
// Ensure this comes AFTER /me/album to avoid 'me' being treated as a :userId
router.get(
  "/:userId/album",
  [
    param("userId")
      .isMongoId()
      .withMessage("Invalid user ID format for album view"),
  ],
  validateRequest,
  getUserAlbum
);

/**
 * ===============================
 *         TASKER MATCHING (Provider only)
 * ===============================
 */
const matchTaskersValidation = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 50 }).toInt(),
];
router.get(
  "/match-taskers",
  restrictTo("provider"),
  matchTaskersValidation,
  validateRequest,
  matchTaskers
);

/**
 * ===============================
 *         STRIPE ONBOARDING (Tasker only)
 * ===============================
 */
router.post("/stripe/connect-account", createStripeAccount); // No body input from user
router.get("/stripe/account-link", createStripeAccountLink); // No params/body
router.get("/stripe/account-status", getStripeAccountStatus); // No params/body
router.get("/stripe/login-link", createStripeLoginLink); // Only taskers can access this route

/**
 * ===============================
 *         ADMIN OPERATIONS
 * ===============================
 */
router.use(restrictTo("admin")); // All routes below are admin-only

const adminGetAllUsersValidation = [
  query("page").optional().isInt({ min: 1 }).toInt(),
  query("limit").optional().isInt({ min: 1, max: 100 }).toInt(),
  // Add other query filters for admin if needed (e.g., ?role=tasker, ?active=true)
];
router.get("/", adminGetAllUsersValidation, validateRequest, getAllUsers); // GET /api/v1/users (admin)

const adminUserByIdParamValidation = [
  param("id")
    .isMongoId()
    .withMessage("Invalid user ID format in URL parameter"),
];
const adminUpdateUserBodyValidation = [
  body("firstName").optional().trim().escape(),
  body("lastName").optional().trim().escape(),
  body("email").optional().isEmail().normalizeEmail(),
  body("phoneNo")
    .optional({ checkFalsy: true })
    .isMobilePhone("any", { strictMode: false }),
  body("role").optional().isArray(),
  body("role.*").isIn(["tasker", "provider", "admin"]),
  body("active").optional().isBoolean().toBoolean(),
  body("isEmailVerified").optional().isBoolean().toBoolean(),
  // Explicitly disallow password changes via this admin route
  body("password")
    .not()
    .exists()
    .withMessage("Admin password updates should use a dedicated mechanism."),
  // Add other fields admin can modify (bio, address, etc.) with their validations
];

router
  .route("/:id") // Base path for admin user operations: /api/v1/users/:id
  .get(adminUserByIdParamValidation, validateRequest, getUser)
  .patch(
    adminUserByIdParamValidation, // Validate param first
    uploadS3.single("profileImage"), // Optional: Allow admin to update profile image
    adminUpdateUserBodyValidation, // Then validate body
    validateRequest,
    updateUser
  )
  .delete(adminUserByIdParamValidation, validateRequest, deleteUser);

export default router;
