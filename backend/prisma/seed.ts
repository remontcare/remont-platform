import { PrismaClient, AmcPlanType, MembershipTier, CouponType, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

const CITIES = [
  { name: 'Mumbai', state: 'Maharashtra', latitude: 19.0760, longitude: 72.8777, multiplier: 1.15, vendors: 680 },
  { name: 'Delhi NCR', state: 'Delhi', latitude: 28.6139, longitude: 77.2090, multiplier: 1.10, vendors: 820 },
  { name: 'Bangalore', state: 'Karnataka', latitude: 12.9716, longitude: 77.5946, multiplier: 1.10, vendors: 540 },
  { name: 'Hyderabad', state: 'Telangana', latitude: 17.3850, longitude: 78.4867, multiplier: 1.00, vendors: 380 },
  { name: 'Pune', state: 'Maharashtra', latitude: 18.5204, longitude: 73.8567, multiplier: 1.00, vendors: 320 },
  { name: 'Chennai', state: 'Tamil Nadu', latitude: 13.0827, longitude: 80.2707, multiplier: 1.00, vendors: 290 },
  { name: 'Kolkata', state: 'West Bengal', latitude: 22.5726, longitude: 88.3639, multiplier: 0.95, vendors: 240 },
  { name: 'Ahmedabad', state: 'Gujarat', latitude: 23.0225, longitude: 72.5714, multiplier: 0.95, vendors: 190 },
  { name: 'Jaipur', state: 'Rajasthan', latitude: 26.9124, longitude: 75.7873, multiplier: 0.90, vendors: 160 },
  { name: 'Lucknow', state: 'Uttar Pradesh', latitude: 26.8467, longitude: 80.9462, multiplier: 0.90, vendors: 130 },
  { name: 'Indore', state: 'Madhya Pradesh', latitude: 22.7196, longitude: 75.8577, multiplier: 0.85, vendors: 110 },
];

const CATEGORIES = [
  { key: 'ac', name: 'AC Service & Repair', icon: '❄️', sortOrder: 1, isPremium: false },
  { key: 'plumbing', name: 'Plumbing', icon: '🚿', sortOrder: 2, isPremium: false },
  { key: 'electrical', name: 'Electrical Work', icon: '💡', sortOrder: 3, isPremium: false },
  { key: 'appliance', name: 'Appliance Repair', icon: '📺', sortOrder: 4, isPremium: false },
  { key: 'cleaning', name: 'Cleaning Services', icon: '🧹', sortOrder: 5, isPremium: false },
  { key: 'interior', name: 'Interior Design', icon: '🛋️', sortOrder: 6, isPremium: true },
  { key: 'renovation', name: 'Renovation', icon: '🔨', sortOrder: 7, isPremium: true },
  { key: 'construction', name: 'Construction', icon: '🏗️', sortOrder: 8, isPremium: true },
];

const SERVICES = [
  // AC
  { categoryKey: 'ac', name: 'AC General Service', basePrice: 599, originalPrice: 899, durationMinutes: 60, skills: ['ac'], isPopular: true },
  { categoryKey: 'ac', name: 'AC Deep Cleaning', basePrice: 999, originalPrice: 1499, durationMinutes: 90, skills: ['ac'] },
  { categoryKey: 'ac', name: 'AC Gas Refill', basePrice: 2499, originalPrice: 3499, durationMinutes: 120, skills: ['ac'] },
  { categoryKey: 'ac', name: 'AC Installation', basePrice: 1499, originalPrice: 1999, durationMinutes: 120, skills: ['ac'] },
  { categoryKey: 'ac', name: 'AC Repair', basePrice: 399, originalPrice: 599, durationMinutes: 60, skills: ['ac'] },
  // Plumbing
  { categoryKey: 'plumbing', name: 'Tap / Leak Fix', basePrice: 199, originalPrice: 399, durationMinutes: 30, skills: ['plumbing'], isPopular: true },
  { categoryKey: 'plumbing', name: 'Toilet Installation', basePrice: 1499, originalPrice: 1999, durationMinutes: 120, skills: ['plumbing'] },
  { categoryKey: 'plumbing', name: 'Pipe Replacement', basePrice: 499, originalPrice: 799, durationMinutes: 90, skills: ['plumbing'] },
  { categoryKey: 'plumbing', name: 'Full Bathroom Renovation', basePrice: 65000, originalPrice: 85000, durationMinutes: 7200, skills: ['plumbing', 'renovation'], isPremium: true },
  // Electrical
  { categoryKey: 'electrical', name: 'Switch / Socket Repair', basePrice: 299, originalPrice: 499, durationMinutes: 45, skills: ['electrical'], isPopular: true },
  { categoryKey: 'electrical', name: 'Fan Installation', basePrice: 399, originalPrice: 599, durationMinutes: 60, skills: ['electrical'] },
  { categoryKey: 'electrical', name: 'Full House Wiring', basePrice: 25000, originalPrice: 35000, durationMinutes: 1440, skills: ['electrical'] },
  { categoryKey: 'electrical', name: 'Inverter Installation', basePrice: 1499, originalPrice: 1999, durationMinutes: 90, skills: ['electrical'] },
  // Appliance
  { categoryKey: 'appliance', name: 'Refrigerator Repair', basePrice: 499, originalPrice: 799, durationMinutes: 90, skills: ['appliance'] },
  { categoryKey: 'appliance', name: 'Washing Machine Repair', basePrice: 449, originalPrice: 699, durationMinutes: 90, skills: ['appliance'] },
  { categoryKey: 'appliance', name: 'TV Repair', basePrice: 399, originalPrice: 599, durationMinutes: 60, skills: ['appliance'] },
  { categoryKey: 'appliance', name: 'Microwave Repair', basePrice: 349, originalPrice: 549, durationMinutes: 60, skills: ['appliance'] },
  // Cleaning
  { categoryKey: 'cleaning', name: 'Deep Home Cleaning', basePrice: 2499, originalPrice: 3499, durationMinutes: 240, skills: ['cleaning'], isPopular: true },
  { categoryKey: 'cleaning', name: 'Bathroom Deep Clean', basePrice: 499, originalPrice: 799, durationMinutes: 90, skills: ['cleaning'] },
  { categoryKey: 'cleaning', name: 'Sofa Cleaning', basePrice: 1499, originalPrice: 2299, durationMinutes: 120, skills: ['cleaning'] },
  { categoryKey: 'cleaning', name: 'Kitchen Deep Clean', basePrice: 999, originalPrice: 1499, durationMinutes: 180, skills: ['cleaning'] },
  // Interior (Premium)
  { categoryKey: 'interior', name: 'Modular Kitchen Design', basePrice: 150000, originalPrice: 200000, durationMinutes: 14400, skills: ['interior'], isPremium: true },
  { categoryKey: 'interior', name: 'Full Home Interior', basePrice: 800000, originalPrice: 1000000, durationMinutes: 43200, skills: ['interior'], isPremium: true },
  { categoryKey: 'interior', name: 'False Ceiling', basePrice: 80, originalPrice: 120, durationMinutes: 4320, skills: ['interior'], isPremium: true },
  { categoryKey: 'interior', name: 'Wardrobe Design', basePrice: 35000, originalPrice: 50000, durationMinutes: 4320, skills: ['interior'], isPremium: true },
  // Renovation (Premium)
  { categoryKey: 'renovation', name: 'Wall Painting', basePrice: 20, originalPrice: 30, durationMinutes: 2880, skills: ['painting'], isPremium: true },
  { categoryKey: 'renovation', name: 'Wall Paneling', basePrice: 250, originalPrice: 350, durationMinutes: 1440, skills: ['carpentry'], isPremium: true },
  { categoryKey: 'renovation', name: 'Tile Work', basePrice: 65, originalPrice: 95, durationMinutes: 2880, skills: ['tiling'], isPremium: true },
  // Construction (Premium)
  { categoryKey: 'construction', name: 'New Build (per sqft)', basePrice: 1500, originalPrice: 2000, durationMinutes: 86400, skills: ['construction'], isPremium: true },
  { categoryKey: 'construction', name: 'Site Visit / Quote', basePrice: 0, originalPrice: 2000, durationMinutes: 120, skills: ['construction'], isPremium: true },
  { categoryKey: 'construction', name: 'Project Management', basePrice: 50000, originalPrice: 80000, durationMinutes: 0, skills: ['construction'], isPremium: true },
];

const PRODUCT_CATEGORIES = [
  { key: 'ac', name: 'Air Conditioners', icon: '❄️', sortOrder: 1 },
  { key: 'plumbing', name: 'Plumbing & Bathroom', icon: '🚿', sortOrder: 2 },
  { key: 'kitchen', name: 'Kitchen & Appliances', icon: '🍳', sortOrder: 3 },
  { key: 'lighting', name: 'Lighting & Electrical', icon: '💡', sortOrder: 4 },
  { key: 'construction', name: 'Construction Materials', icon: '🧱', sortOrder: 5 },
];

const PRODUCTS = [
  { categoryKey: 'ac', name: 'Daikin 1.5T 5-Star Inverter AC', brand: 'Daikin', price: 34990, mrp: 44990 },
  { categoryKey: 'ac', name: 'V-Guard AC Voltage Stabilizer 4kVA', brand: 'V-Guard', price: 2799, mrp: 3999 },
  { categoryKey: 'plumbing', name: 'Jaquar Premium Mixer Tap', brand: 'Jaquar', price: 2499, mrp: 3999 },
  { categoryKey: 'plumbing', name: 'Kohler Wall-Mounted Toilet Seat', brand: 'Kohler', price: 8999, mrp: 12500 },
  { categoryKey: 'kitchen', name: 'Faber Auto-Clean Chimney 90cm', brand: 'Faber', price: 14999, mrp: 22000 },
  { categoryKey: 'kitchen', name: 'Carysil Stainless Steel Kitchen Sink', brand: 'Carysil', price: 6499, mrp: 9999 },
  { categoryKey: 'lighting', name: 'Philips Smart LED Pendant Set', brand: 'Philips', price: 4799, mrp: 6999 },
  { categoryKey: 'construction', name: 'UltraTech PPC Cement 50kg Bag', brand: 'UltraTech', price: 385, mrp: 450 },
  { categoryKey: 'construction', name: 'TATA TISCON TMT Steel Bar (per tonne)', brand: 'TATA TISCON', price: 62990, mrp: 68000 },
];

const AMC_PLANS = [
  {
    type: AmcPlanType.HOME_ESSENTIALS,
    name: 'Home Essentials',
    description: 'Perfect starter plan for small homes & apartments.',
    durationMonths: 12,
    priceYearly: 6999,
    freeServicesCount: 6,
    discountPercent: 15,
    prioritySupport: false,
    includedServices: ['ac', 'plumbing', 'electrical'],
    benefitsJson: {
      bullets: [
        '6 service visits/year', '15% off all bookings',
        '24/7 chat support', 'Free annual deep cleaning',
      ],
    },
  },
  {
    type: AmcPlanType.HOME_COMPLETE,
    name: 'Home Complete',
    description: 'Full coverage for homes that want zero hassle.',
    durationMonths: 12,
    priceYearly: 12999,
    freeServicesCount: 999,
    discountPercent: 30,
    prioritySupport: true,
    isPopular: true,
    includedServices: ['ac', 'plumbing', 'electrical', 'appliance', 'cleaning'],
    benefitsJson: {
      bullets: [
        'Unlimited service visits', '2 × deep cleaning per year',
        'Appliance repair included', '24/7 emergency support',
        '30% off renovation services', 'Dedicated relationship manager',
      ],
    },
  },
  {
    type: AmcPlanType.CORPORATE,
    name: 'Corporate / Office',
    description: 'Designed for offices, retail spaces, and facility management.',
    durationMonths: 12,
    priceYearly: 99999,
    freeServicesCount: 999,
    discountPercent: 25,
    prioritySupport: true,
    includedServices: ['ac', 'plumbing', 'electrical', 'appliance', 'cleaning'],
    benefitsJson: {
      bullets: [
        'SLA-backed response times', 'Dedicated B2B account manager',
        'Monthly preventive maintenance', 'GST-compliant invoicing',
        '30-day credit terms', 'Multi-location coverage',
      ],
    },
  },
];

const MEMBERSHIP_PLANS = [
  {
    tier: MembershipTier.SILVER, name: 'Remont Silver',
    description: 'Free wallet credits + small monthly discount',
    priceMonthly: 99, priceYearly: 999,
    discountPercent: 5, freeServicesCount: 0,
    prioritySupport: false, freeDelivery: false, exclusiveDeals: false,
  },
  {
    tier: MembershipTier.GOLD, name: 'Remont Gold',
    description: 'Free deliveries + better discounts + priority support',
    priceMonthly: 199, priceYearly: 1999,
    discountPercent: 10, freeServicesCount: 1,
    prioritySupport: true, freeDelivery: true, exclusiveDeals: true,
  },
  {
    tier: MembershipTier.PLATINUM, name: 'Remont Platinum',
    description: 'Maximum savings, VIP support, exclusive deals',
    priceMonthly: 499, priceYearly: 4999,
    discountPercent: 20, freeServicesCount: 3,
    prioritySupport: true, freeDelivery: true, exclusiveDeals: true,
  },
];

const COUPONS = [
  {
    code: 'WELCOME50', type: CouponType.PERCENT, discountPercent: 50,
    maxDiscount: 250, minOrderAmount: 299, perUserLimit: 1,
    validTill: new Date(Date.now() + 90 * 86400000),
    isActive: true,
  },
  {
    code: 'AC100OFF', type: CouponType.FLAT, discountAmount: 100,
    minOrderAmount: 499, perUserLimit: 3,
    applicableServices: ['ac'],
    validTill: new Date(Date.now() + 60 * 86400000),
    isActive: true,
  },
  {
    code: 'NEW20', type: CouponType.PERCENT, discountPercent: 20,
    maxDiscount: 500, perUserLimit: 1, totalUsageLimit: 10000,
    validTill: new Date(Date.now() + 30 * 86400000),
    isActive: true,
  },
];

async function slugify(s: string): Promise<string> {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function main() {
  console.log('🌱 Starting seed...');

  // ─── Cities ───
  for (const c of CITIES) {
    await prisma.city.upsert({
      where: { name: c.name },
      update: {},
      create: {
        name: c.name, state: c.state,
        latitude: c.latitude, longitude: c.longitude,
        pincodes: [], isActive: true,
        activeVendors: c.vendors, priceMultiplier: c.multiplier,
        activeServiceKeys: ['ac', 'plumbing', 'electrical', 'appliance', 'cleaning', 'interior', 'renovation', 'construction'],
      },
    });
  }
  console.log(`✅ Seeded ${CITIES.length} cities`);

  // ─── Service Categories ───
  const catMap: Record<string, string> = {};
  for (const cat of CATEGORIES) {
    const c = await prisma.serviceCategory.upsert({
      where: { key: cat.key },
      update: {},
      create: {
        key: cat.key, name: cat.name, icon: cat.icon,
        sortOrder: cat.sortOrder, isActive: true, isPremium: cat.isPremium,
      },
    });
    catMap[cat.key] = c.id;
  }
  console.log(`✅ Seeded ${CATEGORIES.length} service categories`);

  // ─── Services ───
  for (const svc of SERVICES) {
    const slug = await slugify(svc.name);
    await prisma.service.upsert({
      where: { slug },
      update: {},
      create: {
        categoryId: catMap[svc.categoryKey],
        name: svc.name, slug,
        basePrice: svc.basePrice, originalPrice: svc.originalPrice,
        durationMinutes: svc.durationMinutes,
        requiredSkills: svc.skills,
        isActive: true,
        isPopular: svc.isPopular || false,
        isPremium: svc.isPremium || false,
      },
    });
  }
  console.log(`✅ Seeded ${SERVICES.length} services`);

  // ─── Product Categories ───
  const prodCatMap: Record<string, string> = {};
  for (const cat of PRODUCT_CATEGORIES) {
    const c = await prisma.productCategory.upsert({
      where: { key: cat.key },
      update: {},
      create: { key: cat.key, name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, isActive: true },
    });
    prodCatMap[cat.key] = c.id;
  }
  console.log(`✅ Seeded ${PRODUCT_CATEGORIES.length} product categories`);

  // ─── Sample Product Vendor + Products ───
  let sampleVendorUser = await prisma.user.findUnique({ where: { phone: '+919999000001' } });
  if (!sampleVendorUser) {
    sampleVendorUser = await prisma.user.create({
      data: {
        phone: '+919999000001', name: 'Remont Sample Vendor',
        role: UserRole.PRODUCT_VENDOR, isVerified: true,
      },
    });
  }
  let sampleVendor = await prisma.productVendor.findUnique({ where: { userId: sampleVendorUser.id } });
  if (!sampleVendor) {
    sampleVendor = await prisma.productVendor.create({
      data: {
        userId: sampleVendorUser.id,
        businessName: 'Remont Direct',
        gstNumber: '27ABCDE1234F1Z5',
        status: 'ACTIVE',
        rating: 4.5,
      },
    });
  }

  for (const prod of PRODUCTS) {
    const slug = await slugify(prod.name);
    await prisma.product.upsert({
      where: { slug },
      update: {},
      create: {
        vendorId: sampleVendor.id,
        categoryId: prodCatMap[prod.categoryKey],
        name: prod.name, slug, sku: `RMNT-${slug.slice(0, 20)}`,
        brand: prod.brand,
        price: prod.price, mrp: prod.mrp,
        stock: 100, images: [], aiEnhancedImgs: [],
        isActive: true,
      },
    });
  }
  console.log(`✅ Seeded ${PRODUCTS.length} sample products`);

  // ─── AMC Plans ───
  for (const plan of AMC_PLANS) {
    await prisma.amcPlan.upsert({
      where: { type: plan.type },
      update: {},
      create: {
        ...plan,
        applicableCities: [],
        isActive: true,
      },
    });
  }
  console.log(`✅ Seeded ${AMC_PLANS.length} AMC plans`);

  // ─── Membership Plans ───
  for (const plan of MEMBERSHIP_PLANS) {
    await prisma.membershipPlan.upsert({
      where: { tier: plan.tier },
      update: {},
      create: { ...plan, isActive: true },
    });
  }
  console.log(`✅ Seeded ${MEMBERSHIP_PLANS.length} membership plans`);

  // ─── Coupons ───
  for (const cp of COUPONS) {
    await prisma.coupon.upsert({
      where: { code: cp.code },
      update: {},
      create: cp,
    });
  }
  console.log(`✅ Seeded ${COUPONS.length} coupons`);

  // ─── Super Admin User ───
  const adminPhone = process.env.ADMIN_DEFAULT_PHONE || '+919876543210';
  await prisma.user.upsert({
    where: { phone: adminPhone },
    update: {},
    create: {
      phone: adminPhone,
      email: process.env.ADMIN_DEFAULT_EMAIL || 'admin@remontindia.com',
      name: 'Super Admin',
      role: UserRole.SUPER_ADMIN,
      isVerified: true,
    },
  });
  console.log(`✅ Seeded super admin user (phone: ${adminPhone})`);

  console.log('\n🎉 Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
