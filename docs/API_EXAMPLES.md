# API Quick Examples — curl

Base URL: `http://localhost:3001/api/v1`

## 1. Authentication

```bash
# Send OTP
curl -X POST http://localhost:3001/api/v1/auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"phone":"+919876543210"}'

# Verify OTP (use OTP from console in dev)
curl -X POST http://localhost:3001/api/v1/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{
    "phone":"+919876543210",
    "otp":"123456",
    "name":"Priya Mehta",
    "language":"MIXED"
  }'

# Refresh token
curl -X POST http://localhost:3001/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"eyJhbGc..."}'
```

Save the `accessToken` from response. Use as `Authorization: Bearer <token>`.

---

## 2. Cities

```bash
# List all cities
curl http://localhost:3001/api/v1/cities

# Check serviceability
curl "http://localhost:3001/api/v1/cities/serviceability?pincode=400001"

# Active services for a city
curl http://localhost:3001/api/v1/cities/Mumbai/services
```

---

## 3. Services (Catalog)

```bash
# All categories with city availability
curl "http://localhost:3001/api/v1/services/categories?city=Mumbai"

# Popular services
curl http://localhost:3001/api/v1/services/popular

# Premium services
curl http://localhost:3001/api/v1/services/premium

# Search
curl "http://localhost:3001/api/v1/services/search?q=ac"

# Single service with city pricing
curl "http://localhost:3001/api/v1/services/<SERVICE_ID>?city=Mumbai"
```

---

## 4. AI Chat

```bash
# Start a chat (public)
curl -X POST http://localhost:3001/api/v1/ai/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message":"AC se thandi hawa nahi aati",
    "city":"Mumbai",
    "customerPhone":"+919876543210",
    "customerName":"Priya"
  }'

# Continue conversation (with sessionId)
curl -X POST http://localhost:3001/api/v1/ai/chat \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId":"<from-previous-response>",
    "message":"Today 3-5 PM"
  }'

# End session and mark conversion
curl -X POST http://localhost:3001/api/v1/ai/session/end \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId":"<id>",
    "orderId":"<order-id>"
  }'
```

---

## 5. Orders

```bash
# Create order
TOKEN="<your-jwt>"

curl -X POST http://localhost:3001/api/v1/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "type":"SERVICE",
    "channel":"AI_CHAT",
    "serviceId":"<service-id>",
    "addressId":"<address-id>",
    "city":"Mumbai",
    "slotStart":"2026-06-02T15:00:00Z",
    "slotEnd":"2026-06-02T17:00:00Z",
    "couponCode":"WELCOME50",
    "walletAmount":100,
    "aiSessionId":"<session-id>"
  }'

# Confirm payment (after Razorpay success)
curl -X POST http://localhost:3001/api/v1/orders/<ORDER_ID>/confirm-payment \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"paymentId":"pay_xxx"}'

# My orders
curl http://localhost:3001/api/v1/orders/mine \
  -H "Authorization: Bearer $TOKEN"

# Cancel order
curl -X PATCH http://localhost:3001/api/v1/orders/<ID>/cancel \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Change of plan"}'
```

---

## 6. Vendor App (Service Vendor)

```bash
VENDOR_TOKEN="<vendor-jwt>"

# Update location (heartbeat every 30s)
curl -X PATCH http://localhost:3001/api/v1/vendors/service/me/location \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"lat":19.0760,"lng":72.8777}'

# Go online
curl -X PATCH http://localhost:3001/api/v1/vendors/service/me/status \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"isOnline":true}'

# My assigned jobs
curl http://localhost:3001/api/v1/vendors/service/me/jobs?status=VENDOR_ASSIGNED \
  -H "Authorization: Bearer $VENDOR_TOKEN"

# Accept job
curl -X POST http://localhost:3001/api/v1/vendors/service/me/jobs/<ORDER_ID>/accept \
  -H "Authorization: Bearer $VENDOR_TOKEN"

# En route
curl -X PATCH http://localhost:3001/api/v1/orders/<ORDER_ID>/en-route \
  -H "Authorization: Bearer $VENDOR_TOKEN"

# Verify start OTP (typed by vendor on-site)
curl -X POST http://localhost:3001/api/v1/orders/<ORDER_ID>/verify-otp \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"otp":"1234"}'

# Propose extra work
curl -X POST http://localhost:3001/api/v1/orders/<ORDER_ID>/extra-work \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "description":"Second AC also needs cleaning",
    "amount":400
  }'

# Complete job
curl -X POST http://localhost:3001/api/v1/orders/<ORDER_ID>/complete \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "photosAfter":["https://...","https://..."]
  }'

# Earnings
curl http://localhost:3001/api/v1/vendors/service/me/earnings \
  -H "Authorization: Bearer $VENDOR_TOKEN"
```

---

## 7. AMC

```bash
# List plans
curl "http://localhost:3001/api/v1/amc/plans?city=Mumbai"

# Subscribe (returns Razorpay order)
curl -X POST http://localhost:3001/api/v1/amc/subscribe \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"planId":"<id>","autoRenew":true}'

# My subscriptions
curl http://localhost:3001/api/v1/amc/mine \
  -H "Authorization: Bearer $TOKEN"

# Use a free service (decrements counter)
curl -X POST http://localhost:3001/api/v1/amc/<SUB_ID>/use-service \
  -H "Authorization: Bearer $TOKEN"
```

---

## 8. CRM

```bash
AGENT_TOKEN="<agent-jwt>"

# Capture lead (public - from any source)
curl -X POST http://localhost:3001/api/v1/crm/leads/capture \
  -H "Content-Type: application/json" \
  -d '{
    "customerName":"Rajesh Kumar",
    "customerPhone":"+919999000123",
    "cityName":"Mumbai",
    "source":"WEBSITE",
    "serviceInterested":"renovation",
    "estimatedValue":150000,
    "utmSource":"facebook",
    "utmCampaign":"renovation_q2"
  }'

# Agent: list leads
curl "http://localhost:3001/api/v1/crm/leads?status=NEW" \
  -H "Authorization: Bearer $AGENT_TOKEN"

# Agent: assign to self
curl -X PATCH http://localhost:3001/api/v1/crm/leads/<LEAD_ID>/assign \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"<my-user-id>"}'

# Log activity
curl -X POST http://localhost:3001/api/v1/crm/leads/<LEAD_ID>/activity \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"CALL",
    "notes":"Customer wants quote for full kitchen renovation. Budget ~1.5L.",
    "outcome":"INTERESTED",
    "nextAction":"Send detailed proposal by Friday"
  }'

# Funnel analytics
curl http://localhost:3001/api/v1/crm/analytics/funnel \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

---

## 9. Admin

```bash
ADMIN_TOKEN="<admin-jwt>"

# Global stats
curl http://localhost:3001/api/v1/admin/stats \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Pending vendor approvals
curl http://localhost:3001/api/v1/admin/vendors/pending \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Approve vendor
curl -X PATCH http://localhost:3001/api/v1/admin/vendors/<ID>/approve \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Search users
curl "http://localhost:3001/api/v1/admin/users?q=priya&role=CUSTOMER" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Adjust wallet (compensation/refund)
curl -X PATCH http://localhost:3001/api/v1/admin/users/<USER_ID>/wallet \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "amount":500,
    "notes":"Goodwill credit for delayed service"
  }'

# Force refund order
curl -X PATCH http://localhost:3001/api/v1/admin/orders/<ID>/refund \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"Vendor no-show, customer dispute"}'
```

---

## 10. Payments (Razorpay)

```bash
# Create payment order (returns Razorpay order ID for client SDK)
curl -X POST http://localhost:3001/api/v1/payments/create-order \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"amount":2999,"orderId":"<order-id>"}'

# Verify signature (client sends after Razorpay returns success)
curl -X POST http://localhost:3001/api/v1/payments/verify \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "orderId":"order_xxx",
    "paymentId":"pay_xxx",
    "signature":"hmac-sha256-from-razorpay"
  }'

# Webhook (Razorpay calls this)
# Configure in Razorpay dashboard:
# URL: https://api.remontindia.com/api/v1/payments/webhook
# Events: payment.captured, payment.failed, refund.created
```

---

## Response Format

All endpoints return:
```json
{
  "success": true,
  "statusCode": 200,
  "data": { ... },
  "timestamp": "2026-06-01T10:00:00.000Z"
}
```

Errors:
```json
{
  "success": false,
  "statusCode": 400,
  "errorCode": "INVALID_OTP",
  "message": "OTP expired",
  "path": "/api/v1/auth/verify-otp",
  "timestamp": "2026-06-01T10:00:00.000Z"
}
```

---

## Swagger UI

Interactive API explorer at: **http://localhost:3001/api/docs**

Try every endpoint with the built-in form. Authorize once with your JWT, and all protected endpoints become callable.
