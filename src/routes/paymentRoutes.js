import express from "express";
import { param } from "express-validator";
import validateRequest from "../middleware/validateRequest.js";
import {
  createPaymentIntentForContract,
  refundPaymentForContract,
  getPaymentIntentForContract, // Import the new controller function
  releasePaymentForContract,
  checkIfContractIsReleasable,
} from "../controllers/paymentController.js";
import { protect, restrictTo } from "../controllers/authController.js";

const router = express.Router();

/**
 * --- Protect Routes ---
 * All routes below this middleware require the user to be logged in.
 */
router.use(protect); // Protect all routes below this middleware (user must be logged in)

/**
 * --- Payment Routes ---
 * These routes handle the creation of payment intents and refunds for contracts.
 */

// Route to create a payment intent for a specific contract.
// Only accessible by users with the 'provider' role (the one offering the service).
router.post(
  "/contracts/:contractId/create-payment-intent",
  [
    restrictTo("provider"), // Only the provider can create a payment intent
    param("contractId").isMongoId().withMessage("Invalid Contract ID format"), // Validate contractId as MongoDB ObjectId
  ],
  validateRequest,
  createPaymentIntentForContract
); // Calls the controller to handle payment intent creation

// Route to refund a payment for a specific contract.
// Only accessible by users with 'admin' or 'provider' roles (admins and the provider can issue a refund).
router.post(
  "/contracts/:contractId/refund",
  [
    restrictTo("admin", "provider"), // Only admin or provider can refund
    param("contractId").isMongoId().withMessage("Invalid Contract ID format"), // Validate contractId as MongoDB ObjectId
    // Optional: body('reason').optional().trim().escape()  // If you want to add a reason for the refund later
  ],
  validateRequest,
  refundPaymentForContract
); // Calls the controller to handle payment refund

// Route to get payment details for a specific contract
router.get(
  "/contracts/:contractId/payment",
  [
    param("contractId").isMongoId().withMessage("Invalid Contract ID format"), // Validate contractId as MongoDB ObjectId
  ],
  validateRequest,
  getPaymentIntentForContract // Calls the controller to handle payment retrieval
);

router.post(
  "/contracts/:contractId/release",
  [
    restrictTo("admin", "provider"), // Only admin or provider can release payment
    param("contractId").isMongoId().withMessage("Invalid Contract ID format"), // Validate contractId as MongoDB ObjectId
  ],
  validateRequest,
  releasePaymentForContract // Calls the controller to handle payment release
);

router.get(
  "/contracts/:contractId/releasable",
  [
    restrictTo("admin", "provider"), // Only admin or provider can check releasability
    param("contractId").isMongoId().withMessage("Invalid Contract ID format"), // Validate contractId as MongoDB ObjectId
  ],
  validateRequest,
  checkIfContractIsReleasable // Calls the controller to check releasability
);

export default router;
