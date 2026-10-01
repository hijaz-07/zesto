import { z } from 'zod';
import type { Order } from '../order/types';
import type { PaymentResponse, PreparedPayment } from './types';

/**
 * Runtime validation of the payment API's responses. Razorpay Checkout is
 * only ever opened with values that pass `preparedPaymentSchema`, so a
 * malformed or partial backend response fails loudly here instead of
 * opening Checkout with missing or unexpected data. The schemas describe
 * the backend's own response shape (functions/src/domain/payments.ts and
 * orders.ts); they don't validate anything against the client's cart or
 * any locally-held amount.
 */

export const preparedPaymentSchema = z.object({
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  amountInPaise: z.number().int().positive(),
  currency: z.literal('INR'),
  // A payment that already succeeded can never be prepared again (the
  // backend rejects a non-`pending_payment` order), so it's not valid here.
  status: z.enum(['pending', 'failed']),
  provider: z.literal('razorpay'),
  providerOrderId: z.string().min(1),
  providerKeyId: z.string().min(1),
}) satisfies z.ZodType<PreparedPayment, unknown>;

const paymentResponseSchema = z.object({
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  amountInPaise: z.number().int().nonnegative(),
  currency: z.literal('INR'),
  status: z.enum(['pending', 'succeeded', 'failed']),
  provider: z.enum(['none', 'razorpay']),
  providerOrderId: z.string().optional(),
  providerPaymentId: z.string().optional(),
}) satisfies z.ZodType<PaymentResponse, unknown>;

const orderSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string(),
  outletId: z.string(),
  menuId: z.string(),
  status: z.enum(['pending_payment', 'confirmed', 'cancelled']),
  paymentStatus: z.enum(['pending', 'paid']),
  currency: z.literal('INR'),
  subtotalInPaise: z.number().int().nonnegative(),
  totalInPaise: z.number().int().nonnegative(),
  items: z.array(
    z.object({
      itemId: z.string(),
      name: z.string(),
      priceInPaise: z.number().int().nonnegative(),
      quantity: z.number().int().positive(),
      lineTotalInPaise: z.number().int().nonnegative(),
    }),
  ),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Order, unknown>;

export const preparePaymentResponseSchema = z.object({ payment: preparedPaymentSchema });

export const verifyPaymentResponseSchema = z.object({
  order: orderSchema,
  payment: paymentResponseSchema,
});
