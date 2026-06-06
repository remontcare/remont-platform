# Backend Architecture — Quick Reference

## Request Flow
```
Client (Web/App/WhatsApp/AI Chat)
  ↓
API Gateway (/api/v1/*)
  ↓
JwtAuthGuard → RolesGuard
  ↓
Controller (HTTP only)
  ↓
Service (business logic)
  ↓
PrismaService → PostgreSQL
  ↓
TransformInterceptor (wraps response)
  ↓
{ success, statusCode, data, timestamp }
```

## Module Dependency Graph
```
AuthModule
  └─ depends on: WhatsappModule (OTP via WA)
                 PrismaModule (user upsert)

OrdersModule (heaviest)
  └─ depends on: CouponsModule, MembershipsModule,
                 CitiesModule (city-wise pricing),
                 WhatsappModule (dispatch)

PaymentsModule
  └─ external: Razorpay SDK

AmcModule
  └─ depends on: PaymentsModule (subscription pay),
                 WhatsappModule (welcome msg)

CrmModule
  └─ standalone (most modules can call CrmService)

AiAgentModule
  └─ depends on: CrmModule (auto-capture leads)

AdminModule
  └─ depends on: PrismaModule only
```

## Smart Dispatch Algorithm
```
1. Get all vendors where:
   - isOnline = true
   - status = ACTIVE
   - skills includes service_category
   - currentLatitude / currentLongitude not null

2. For each vendor:
   distance = haversine(order.lat, order.lng, vendor.lat, vendor.lng)
   if distance > vendor.serviceRadius: skip
   score = (rating / 5) * 50
         + max(0, 50 - distance * 5)
         + (isVipPro ? 10 : 0)

3. Sort by score DESC
4. Take top 5
5. Send WhatsApp to each (parallel)
6. First to accept wins
```

## Order Lifecycle (10 states)
```
PENDING_PAYMENT
  ↓ confirmPayment()
CONFIRMED
  ↓ dispatch (auto)
VENDOR_ASSIGNED
  ↓ acceptJob() by vendor
VENDOR_EN_ROUTE
  ↓ markEnRoute() by vendor
STARTED (after verifyStartOtp)
  ↓ photosBefore uploaded
IN_PROGRESS
  ↓ addExtraWork (optional)
EXTRA_WORK_ADDED → customer approves → back to IN_PROGRESS
  ↓ complete() with photosAfter
COMPLETED

Terminal: CANCELLED, REFUNDED
```

## 3-Part Invoice Math
```
Page 1 (Customer):
  customerSubtotal = serviceAmount + productsAmount + extraWorkAmount
  customerCgst = gstAmount / 2
  customerSgst = gstAmount / 2
  customerTotal = subtotal + gst - discounts

Page 2 (Vendor):
  vendorLabor = serviceAmount + extras
  vendorMaterial = 0  // tracked separately if vendor sells materials
  vendorCgst = vendorPretax * 0.09
  vendorSgst = vendorPretax * 0.09
  vendorTotal = vendorPretax * 1.18

Page 3 (Remont):
  platformCommission = serviceAmount * 0.15
  bookingFee = 49
  remontCgst = (commission + fee) * 0.09
  remontSgst = (commission + fee) * 0.09
  remontTotal = (commission + fee) * 1.18

INVARIANT: vendorTotal + remontTotal = customerTotal
```

## Auth Roles & Access
```
SUPER_ADMIN     → Everything
ADMIN           → Most things except settings
CRM_AGENT       → /crm/*, read customer data
VENDOR_SUCCESS  → /vendors/*, read orders (no refunds)
FINANCE         → /payouts/*, /invoices/*, refunds
SERVICE_VENDOR  → /vendors/service/me/*, accept jobs
PRODUCT_VENDOR  → /vendors/product/me/*, /products (own)
DELIVERY_PARTNER → /delivery/me/*
CORPORATE_USER  → /corporate/*, book like retail
CUSTOMER        → Everything customer-facing
```

## City-Wise Pricing
```
basePrice = service.basePrice
multiplier = city.priceMultiplier  // e.g., 1.15 for Mumbai

finalPrice = basePrice * multiplier

// Per-service override:
if CityService(cityId, serviceId).customPrice exists:
  finalPrice = CityService.customPrice  // overrides multiplier
```

## Response Envelope
```json
// Success
{
  "success": true,
  "statusCode": 200,
  "data": { ... },
  "timestamp": "2026-06-01T10:00:00.000Z"
}

// Error
{
  "success": false,
  "statusCode": 400,
  "errorCode": "INVALID_OTP",
  "message": "OTP expired",
  "path": "/api/v1/auth/verify-otp",
  "timestamp": "2026-06-01T10:00:00.000Z"
}
```

## Rate Limits
- Global: 200 req/min/IP
- OTP send: 5 req/min/phone (separate guard)
- Webhooks: no limit (Razorpay can burst)
