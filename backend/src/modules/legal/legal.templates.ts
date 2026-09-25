/**
 * Default templates for the built-in main policy documents.
 *
 * These seed a v0.1 DRAFT per policy — nothing here is ever published
 * automatically, and an existing policy is never overwritten. Wording only
 * describes behaviour the platform actually has today (checked against the
 * backend: manual-review refunds, wallet-credit default, OTP-verified job
 * start/finish, category-level workmanship warranty, admin-approved partner
 * withdrawals, seller-recommends/admin-decides returns, no analytics or
 * advertising trackers on the website).
 *
 * Anything only the business can supply — percentages, fees, timelines,
 * jurisdictions, officer identity — is a [[placeholder]]. The admin UI and the
 * publish endpoint flag every remaining [[…]] before a version goes live.
 * {{VARIABLES}} are filled from Settings → Legal Information at render time.
 *
 * Nothing here claims legal compliance or platform (Meta/Google Play) approval. This is a policy-management starting point, not legal advice: every
 * document should be reviewed by a qualified lawyer before publishing.
 */

export interface PolicySectionTemplate { title: string; content: string }
export interface PolicyTemplate {
  slug: string;
  publicPath: string;
  policyType: string;
  category: string;
  title: string;
  description: string;
  seoTitle: string;
  seoDescription: string;
  sortOrder: number;
  sections: PolicySectionTemplate[];
}

const p = (...paras: string[]) => paras.map((t) => `<p>${t}</p>`).join('');
const ul = (...items: string[]) => `<ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul>`;
const ph = (what: string) => `[[${what}]]`;
const s = (title: string, content: string): PolicySectionTemplate => ({ title, content });

const CONTACT = p('For questions about this policy, contact {{COMPANY_NAME}} at {{SUPPORT_EMAIL}} or {{SUPPORT_PHONE}}, or write to {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}. Grievances can be raised with our Grievance Officer at {{GRIEVANCE_EMAIL}} — see our <a href="/grievance-policy">Grievance &amp; Legal Policy</a>.');
const CHANGES = p('We may update this policy as our services change. The version number and "Last updated" date at the top of this page identify the version in force. Earlier versions are retained in our records.');
const PLATFORM_ROLE = p('{{COMPANY_NAME}} is a technology and service-facilitation platform. It connects customers with independent service professionals and technicians ("Partners"), service agencies and, where applicable, third-party sellers ("Sellers"). Partners and Sellers are independent businesses or individuals, not employees of {{COMPANY_NAME}}, unless we expressly say otherwise for a particular service.');
const VERIFICATION_STATUS = p('Partner and seller applications are reviewed by our team, which checks the information and documents submitted (such as PAN, GST or bank details and, where provided, a police verification certificate) before approving an account. Any "verified" or "approved" status on the platform means only that the specific checks we actually carried out were completed at that time. It is not a guarantee of a person\'s identity beyond those checks, character, criminal history, future conduct or workmanship, and we do not perform checks we have not described.');
const UNLAWFUL_ACTIVITY = p('{{COMPANY_NAME}} does not knowingly support or authorise fraud, theft, violence, harassment, threats, child exploitation, sexual exploitation, trafficking, cybercrime, unauthorised access to accounts or systems, illegal financial activity or any other unlawful activity on or through the platform.', 'Where we become aware of such activity, we may suspend or restrict accounts, remove content, cancel bookings where appropriate, preserve relevant records and cooperate with lawful requests from government authorities and law enforcement. We are not a law-enforcement agency; if you are in immediate danger, contact the police (dial 112).');
const PLATFORM_LIMITS = p('{{COMPANY_NAME}} provides a technology and service-facilitation platform. Where services or products are provided by independent professionals or third parties, {{COMPANY_NAME}} does not guarantee their future conduct or every aspect of their performance beyond the checks, commitments and warranties that {{COMPANY_NAME}} expressly provides. Detailed commercial terms, including responsibility and liability for orders, are set out in our <a href="/terms">Terms &amp; Conditions</a>.');
const NON_EXCLUSION = p('Nothing in this policy or other platform documentation is intended to exclude, restrict or waive any liability, obligation, responsibility or legal remedy that cannot lawfully be excluded, restricted or waived under applicable law.');
const REFUND_REVIEW = p('No refund is issued automatically. Every refund request is reviewed by our support team, which may ask the assigned Partner or Seller to respond before deciding. See our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.');

export const GENERIC_SECTIONS: PolicySectionTemplate[] = [
  s('Introduction', p(`This policy explains ${ph('what this policy covers')} for users of {{COMPANY_NAME}} ({{WEBSITE_URL}}).`)),
  s('Scope', p(`This policy applies to ${ph('who and what this policy applies to')}.`)),
  s('Policy Details', p(ph('Main rules of this policy'))),
  s('Responsibilities', p(ph('Responsibilities of each party'))),
  s('Changes to This Policy', CHANGES),
  s('Contact', CONTACT),
];

export const POLICY_TEMPLATES: PolicyTemplate[] = [
  // ─── A. PRIVACY ───────────────────────────────────────────────────────────
  // Audited against the code on 25 Sep 2026: data fields of User / Address / Order /
  // PartnerRegistration / SellerRegistration / Lead / AiSession, payment gateways actually
  // integrated (Razorpay, PhonePe), MSG91, Firebase push, Cloudinary, OpenAI, OpenStreetMap/
  // Nominatim, Google Fonts/Maps links. There is no self-service account deletion — deletion is
  // contact-based. Meta messaging runs in the separate Remont One CRM, so it is described
  // conditionally ("where connected"). No [[placeholders]]: it can be published as soon as the
  // critical Legal Information fields are filled.
  {
    slug: 'privacy-policy', publicPath: '/privacy', policyType: 'PRIVACY', category: 'Privacy', sortOrder: 1,
    title: 'Privacy Policy',
    description: 'How personal data of customers, partners/technicians and sellers is collected, used, shared and protected — including Meta (WhatsApp, Facebook, Instagram) messaging and AI-assisted communication.',
    seoTitle: 'Privacy Policy | Remont India',
    seoDescription: 'How Remont India collects, uses, shares and protects personal data, including WhatsApp/Meta messages, AI-assisted communication and your rights.',
    sections: [
      s('Introduction and Scope', p(
        'This Privacy Policy explains how {{COMPANY_LEGAL_NAME}} ("{{COMPANY_NAME}}", "we", "us") collects, uses, shares, retains and protects personal data when you use {{WEBSITE_URL}}, our mobile web experience, our partner and seller registration flows, our AI chat assistant, and messaging channels we operate (such as WhatsApp, Facebook Messenger and Instagram).',
        'We decide why and how personal data is processed on our platform. We process personal data in accordance with applicable Indian law, including the Information Technology Act, 2000 and the Digital Personal Data Protection Act, 2023 and the rules made under them, to the extent they apply.',
        'Please read this policy together with our <a href="/terms">Terms &amp; Conditions</a>, <a href="/cookie-policy">Cookie &amp; Technology Policy</a> and <a href="/ai-policy">AI &amp; Communication Policy</a>.',
      )),
      s('Our Role as a Platform', PLATFORM_ROLE + VERIFICATION_STATUS),
      s('Information We Collect', p('We collect only what we need for the purposes described in this policy:') + ul(
        '<strong>Information you give us</strong> — account, booking, registration, support and message content.',
        '<strong>Information created when you use the platform</strong> — orders, job status, one-time-code confirmations, invoices, wallet and payment records, reviews and support cases.',
        '<strong>Technical information</strong> — IP address and browser/device information sent with each request, and preferences stored in your browser (see our Cookie &amp; Technology Policy).',
        '<strong>Information from others</strong> — for example payment status from our payment gateway, and message and sender details from Meta when you message us on a connected channel.',
      )),
      s('Customer Information', p('Name, mobile number (verified by OTP), email if provided, saved addresses, bookings and orders, service or product details, slot, payment status, wallet balance and transactions, invoices, ratings and reviews, refund and support requests, and communications about your orders. If you are a business customer, we also process the business and GST details you provide.')),
      s('Partner / Technician Information', p('If you register as a service partner or technician we process: name, mobile number, email, gender (if provided), address, service categories, skills and experience, previous employer (if provided), availability, GPS work location, PAN number and PAN card image, profile photo, a police verification certificate if you choose to upload one, bank account and/or UPI details for payouts, emergency contact details, your agreement confirmations, and — once approved — jobs, ratings, earnings, wallet, withdrawals and adjustments.', 'Emergency contact details are about another person; please share them only with that person\'s knowledge. Documents are reviewed by our team as described in "Our Role as a Platform".')),
      s('Seller Information', p('If you register as a product seller we process: business and owner name, mobile number, email, business address and pickup locations, GST number and certificate, PAN number and PAN card image, Aadhaar number and Aadhaar document image (if provided), owner photo, bank account details and passbook image, other documents you upload, product listings, orders, returns, settlements and agreement confirmations.', 'Aadhaar details are used only to review your identity as part of seller onboarding. We do not perform Aadhaar (UIDAI) authentication. Where possible, you may mask the first eight digits of your Aadhaar number on the document image.')),
      s('Address and Location / GPS', p('Customers: location access is optional — you can type your address instead. If you allow it, we use GPS to pre-fill your address, suggest the nearest serviced city and show a map reference for the service location.', 'Partners: a GPS location within India is required at registration so that nearby jobs can be offered.', 'Addresses may be converted to and from coordinates using an OpenStreetMap-based geocoding service. "Navigate" links open Google Maps with only the destination coordinates.')),
      s('Bookings and Orders', p('When you book a service or buy a product we record what was ordered, the service or delivery address, slot, assigned partner or seller, one-time codes used to confirm job start, completion, additional work or delivery, any additional work you approve, invoices and the order timeline. The assigned partner, seller or delivery partner receives the details needed to complete that order.')),
      s('Payment Information', p('Online payments are processed by our payment gateway partners — currently Razorpay and PhonePe, depending on the payment option used. We receive the payment outcome (amount, status, method and gateway reference). We do not receive or store your full card number, CVV, UPI PIN or net-banking password. Cash-on-service collections, wallet credits and refunds are recorded against your order.')),
      s('Enquiries, Leads and CRM', p('When you enquire through our website, AI chat assistant, a messaging channel or by phone, we may create or update an enquiry ("lead") record in our customer relationship management (CRM) system. A lead can include your name, phone number, email, city, service of interest, estimated value, photos you share, notes from our team, follow-up dates, the channel you used and, if you arrived through a marketing link, the campaign source parameters (UTM tags) in that link. Our team uses leads to follow up with you and to convert enquiries into bookings.')),
      s('WhatsApp, Facebook, Instagram and Meta', p('We may communicate with you through Meta platforms that we have connected to our business tools, which can include the WhatsApp Business Platform, Facebook Pages and Messenger, and Instagram professional accounts, managed through Meta Business tools. When you message us on a connected channel, we receive and process, through Meta\'s APIs and webhook events:') + ul(
        'the messages you send us and our replies, including media you choose to share;',
        'sender information that Meta makes available to businesses, such as your WhatsApp phone number, your profile or display name, and the app- or page-scoped identifier Meta assigns to you;',
        'conversation metadata such as timestamps, message delivery/read status and conversation identifiers;',
        'identifiers of our own business assets (such as our Page, Instagram account and WhatsApp Business number) needed to route the conversation;',
        'enquiry details from the conversation, which may be saved as a CRM lead.',
      ) + p('We only receive information Meta provides to businesses for conversations you start or continue with us; we do not receive your Facebook or Instagram password, your private messages with other people, or your friends lists. Access tokens that connect our business accounts are stored securely on our servers and are never shown to users.', 'We use this information to reply to you, provide service information, handle enquiries, bookings and support, and improve our responses. We do not sell it. Meta\'s own processing of your data is governed by Meta\'s privacy policy.', 'We also send transactional messages (such as OTPs and order updates) by SMS and WhatsApp through our messaging service provider (currently MSG91).')),
      s('AI-Assisted Communication', p('Some conversations are handled first by an AI assistant — our website chat assistant and, where enabled, assistants on connected messaging channels. The assistant is software, not a human and not a technician. It may:') + ul(
        'answer questions about our services, coverage and policies;',
        'look up our live service catalogue and the prices available for your city;',
        'collect enquiry details such as the service needed, city and preferred time, and qualify the enquiry;',
        'create or update a lead in our CRM, or start a cart, booking or registration draft for you to complete;',
        'summarise a conversation for our team;',
        'hand the conversation to a human member of our team.',
      ) + p('AI responses may contain errors. Prices and estimates are indicative until confirmed by the assigned professional, and the assistant does not make final decisions on refunds, disputes, account suspension or payouts. You can ask to speak with a person at any time.', 'Website chat conversations are stored with the chat session (and linked to your account if you are signed in). Messages sent to the assistant are processed by a third-party AI model provider (currently OpenAI) acting on our behalf to generate replies.')),
      s('Google and Other Service Providers', p('We use service providers that process personal data on our behalf, only as needed for their function:') + ul(
        '<strong>Payments</strong> — Razorpay and PhonePe.',
        '<strong>SMS / WhatsApp transactional messages</strong> — MSG91.',
        '<strong>Push notifications</strong> — Firebase Cloud Messaging (Google), only if you allow browser notifications.',
        '<strong>Image and document storage/delivery</strong> — Cloudinary.',
        '<strong>AI assistant</strong> — OpenAI.',
        '<strong>Maps and geocoding</strong> — OpenStreetMap / Nominatim; Google Maps for directions links you open.',
        '<strong>Web fonts</strong> — Google Fonts, which receives your IP address when our pages load fonts.',
        '<strong>Meta platforms</strong> — for connected messaging channels, as described above.',
      ) + p('We do not use third-party advertising or analytics trackers on our website.')),
      s('How We Use Personal Data', ul(
        'To create and manage accounts and verify phone numbers.',
        'To take bookings and orders, match a nearby partner or seller, and fulfil them.',
        'To process payments, wallet credits, refunds, partner payouts and seller settlements.',
        'To issue invoices and meet accounting, tax and other legal obligations.',
        'To review partner and seller applications and keep the platform safe, including preventing fraud and misuse.',
        'To respond to enquiries, provide support, and resolve complaints and disputes.',
        'To send transactional messages, and — where you have agreed — service updates.',
        'To improve matching, pricing accuracy and service quality.',
      ) + p('We process personal data on the basis of your consent, for uses you have voluntarily provided the data for, or where otherwise permitted or required by law. Where we rely on consent you may withdraw it (see "Your Rights"); this does not affect processing already carried out.')),
      s('How We Share Personal Data', ul(
        'With the partner or delivery partner assigned to your order — your service address and the contact details needed for that job.',
        'With sellers — the details needed to fulfil and ship your product order.',
        'With our service providers listed above, under their contractual and legal obligations.',
        'With government authorities, courts or law enforcement where required by law or a lawful request, or to protect the rights, property or safety of users, the public or us.',
      ) + p('We do not sell personal data.')),
      s('Data Retention', p('We keep personal data only as long as needed for the purpose it was collected for, or as required by law. Order, invoice, payment and tax records are kept for the periods required by accounting and tax laws. Account and address details are kept until you ask us to delete them, subject to records we must retain. Registration documents, conversation and lead records are kept while they are needed for the relationship, support, dispute resolution or legal obligations, and are then deleted or anonymised.')),
      s('Data Security', p('We use reasonable security safeguards, including encrypted connections (HTTPS), OTP-based sign-in, role-based access for staff, audit logs for sensitive admin actions, scanning of uploaded files and restricted storage of payment and messaging credentials. No system is completely secure. If a personal data breach occurs, we will act to contain it and will notify affected persons and authorities where required by applicable law.')),
      s('Your Rights', p('Subject to applicable law, you may:') + ul(
        'ask for a summary of the personal data we process about you and how it is processed;',
        'ask us to correct, complete or update inaccurate or incomplete data;',
        'ask us to erase personal data that is no longer needed, unless we must retain it by law;',
        'withdraw consent you have given (for example for location or push notifications — also via your browser settings);',
        'raise a grievance with us, and, where the law provides, nominate another person to exercise your rights in the event of death or incapacity.',
      ) + p('Send requests to {{PRIVACY_EMAIL}} from your registered phone number or email so that we can verify your identity. We will respond within the time required by applicable law. If you are not satisfied with our response, you may escalate to our Grievance Officer and, where the law provides, complain to the Data Protection Board of India. You can view, edit and delete your saved addresses yourself in your account.')),
      s('Account and Data Deletion', p('Self-service account deletion is not yet available in our app or website. To delete your account and associated personal data, email {{PRIVACY_EMAIL}} from your registered contact details (or tell us the registered phone number), with the subject "Delete my account". We will verify the request, delete or anonymise your personal data, and confirm when it is done.', 'We may keep records we are legally required to retain (for example invoices and payment records), and data needed for an open order, refund, dispute or legal claim, until that is resolved.', 'To delete data we received through WhatsApp, Messenger or Instagram, email {{PRIVACY_EMAIL}} with the phone number or account name you used, or ask us in that conversation.')),
      s("Children's Personal Data", p('Our accounts and services are meant for adults (18 years or older) booking services for their homes or businesses, and are not directed at children. We do not knowingly collect personal data from children without the verifiable consent of a parent or lawful guardian.', 'If a parent or guardian provides a child\'s personal data (for example a name in a booking note), they confirm that they have authority to do so, and we use it only for that booking. We do not use children\'s personal data for tracking, behavioural monitoring or targeted advertising. If we learn that we have collected a child\'s personal data without the required consent, we will delete it. Parents or guardians can contact {{PRIVACY_EMAIL}}.')),
      s('Unlawful Activity and Cooperation with Authorities', UNLAWFUL_ACTIVITY),
      s('Liability and Your Legal Rights', PLATFORM_LIMITS + NON_EXCLUSION),
      s('Changes to This Policy', CHANGES + p('Where changes are significant, we will take reasonable steps to tell you, for example by a notice on the website.')),
      s('Contact and Grievance Officer', p('Privacy questions and data requests: {{PRIVACY_EMAIL}}.<br>Grievance Officer: {{GRIEVANCE_OFFICER}}<br>Grievance email: {{GRIEVANCE_EMAIL}}<br>Postal address: {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}', 'See our <a href="/grievance-policy">Grievance &amp; Legal Policy</a> for how complaints are handled.')),
    ],
  },

  // ─── B. TERMS ─────────────────────────────────────────────────────────────
  {
    slug: 'terms-and-conditions', publicPath: '/terms', policyType: 'TERMS', category: 'Terms', sortOrder: 2,
    title: 'Terms & Conditions',
    description: 'The rules for using the platform as a customer, partner or seller.',
    seoTitle: 'Terms & Conditions | Remont India',
    seoDescription: 'Terms and conditions for using Remont India as a customer, service partner or product seller.',
    sections: [
      s('Introduction', p('These Terms govern your use of {{WEBSITE_URL}} and the services of {{COMPANY_LEGAL_NAME}} ("{{COMPANY_NAME}}") for home services, products and Annual Maintenance Contracts (AMC).') + PLATFORM_ROLE + p('The work or product is provided by the assigned Partner or Seller; {{COMPANY_NAME}} facilitates discovery, booking, payment and support, and provides the commitments (such as refund review and any stated workmanship warranty) described in our policies.')),
      s('Verification of Partners and Sellers', VERIFICATION_STATUS),
      s('Platform Usage', p('You may use the platform only for lawful purposes and in line with these Terms and our other published policies, which form part of these Terms.')),
      s('Account Registration', p('Accounts are created with a mobile number verified by OTP. You are responsible for the accuracy of your details and for keeping your OTPs confidential. Partner and Seller accounts are reviewed and approved by our team before they can take work.')),
      s('Customer Responsibilities', p('See our <a href="/customer-policy">Customer Policy</a>. In short: give accurate booking details, provide safe access to the service location, approve any additional work before it starts, and share job OTPs only with the Partner assigned to your order.')),
      s('Partner Responsibilities', p('See our <a href="/partner-policy">Partner Policy</a>. Partners must complete onboarding review, follow our service and conduct standards, and use the platform\'s OTP and job flows for every job.')),
      s('Seller Responsibilities', p('See our <a href="/seller-policy">Seller Policy</a>. Sellers must list accurate products, keep stock current, dispatch on time and handle returns and warranty as described.')),
      s('Marketplace Rules', p('See our <a href="/marketplace-policy">Marketplace Policy</a> for rules that apply to all participants, including prohibited products and services.')),
      s('Orders and Bookings', p('Bookings can be made on the website, through our AI chat assistant, on WhatsApp or by phone, and are subject to Partner/Seller and slot availability in your city. An order is confirmed when it appears in "My Orders" with a confirmed status.')),
      s('Pricing', p('For many services the final price is confirmed by the assigned professional after an on-site inspection and requires your approval before work begins. Where a fixed price is shown at booking, it is honoured unless the scope of work changes with your approval. Prices include or exclude GST as shown at checkout.')),
      s('Payments', p('Payment options offered for an order may include online payment through our payment gateway, cash/UPI/card at completion, and Remont Wallet balance. See our <a href="/payment-policy">Payment Policy</a>.')),
      s('Cancellation', p('You can cancel a booking from "My Orders" before the assigned professional starts work. After work has started, cancellation is only possible through support. See our <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.')),
      s('Refunds', REFUND_REVIEW),
      s('Intellectual Property', p('The platform, its content, branding and software belong to {{COMPANY_LEGAL_NAME}} or its licensors. You may not copy, scrape or reuse them without written permission. Sellers and Partners grant us the right to display the content they upload for the purpose of operating the marketplace.')),
      s('Prohibited Activities', ul(
        'Providing false identity, KYC, address or payment information.',
        'Taking or arranging payment for platform jobs outside the platform.',
        'Harassment, abuse or unsafe conduct toward any customer, Partner, Seller or staff member.',
        'Listing prohibited, counterfeit or unsafe products.',
        'Attempting to access other accounts, bypass OTPs or interfere with the platform.',
      )),
      s('Suspension / Termination', p('We may suspend or close accounts that breach these Terms or our policies, pending investigation where appropriate. Amounts legitimately owed at the time of closure are settled in line with the relevant policy.')),
      s('Dispute Resolution', p('Please raise any issue with support first; most disputes are resolved there. Unresolved disputes may be escalated as described in our <a href="/grievance-policy">Grievance &amp; Legal Policy</a>.')),
      s('Unlawful Activity', UNLAWFUL_ACTIVITY),
      s('Responsibility and Liability', PLATFORM_LIMITS.replace(' Detailed commercial terms, including responsibility and liability for orders, are set out in our <a href="/terms">Terms &amp; Conditions</a>.', '') + p('{{COMPANY_NAME}} is responsible for the platform, for handling payments made through it, and for the commitments it expressly makes (such as reviewing refund requests and any workmanship warranty stated on your invoice). ' + ph('Any monetary cap or other limitation of liability — to be settled with legal counsel')) + NON_EXCLUSION),
      s('Governing Law', p('These Terms are governed by the laws of India. Subject to applicable law, courts at ' + ph('jurisdiction city/state — current website states Madhya Pradesh') + ' have jurisdiction.')),
      s('Changes to These Terms', CHANGES),
      s('Contact', CONTACT),
    ],
  },

  // ─── C. CUSTOMER ──────────────────────────────────────────────────────────
  {
    slug: 'customer-policy', publicPath: '/customer-policy', policyType: 'CUSTOMER', category: 'Users', sortOrder: 3,
    title: 'Customer Policy',
    description: 'Rules for customers booking services and buying products.',
    seoTitle: 'Customer Policy | Remont India',
    seoDescription: 'Booking, rescheduling, cancellation, warranty and conduct rules for Remont India customers.',
    sections: [
      s('Customer Account', p('Your account is linked to a mobile number verified by OTP. Keep your OTPs private — our staff will never ask for your login OTP.')),
      s('Booking Rules', p('Choose the service, address and slot, and confirm the booking. Provide accurate details about the problem so the right professional is assigned.')),
      s('Service Address', p('The service address must be within a city we serve and accessible to the professional at the booked time. You can manage saved addresses in your account.')),
      s('Appointment Slots', p('Slots are subject to availability. The professional may contact you on your registered number to confirm arrival.')),
      s('Rescheduling', p('To reschedule, contact support from your order in "My Orders" or through our contact channels. ' + ph('Any rescheduling limits or charges'))),
      s('Cancellation', p('You can cancel from "My Orders" before the professional starts work. See the <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.')),
      s('No-Show', p(ph('Customer no-show rule — e.g. what happens if the professional arrives and the customer is unavailable, and any visit charge'))),
      s('Service Quality', p('A one-time code confirms the start and completion of each job. If you are unhappy with the work, report it from your order so we can review it — including by asking the professional to redo it where appropriate.')),
      s('Warranty', p('Where a service category carries a workmanship warranty, the warranty period is shown on your invoice and covers workmanship only (not parts or new faults). Raise a warranty claim from your order within that period.')),
      s('Refund', REFUND_REVIEW),
      s('Customer Behaviour', p('Treat professionals and staff with respect and provide a safe working environment. Abusive or unsafe behaviour may lead to cancellation of the booking and suspension of the account.')),
      s('Complaints', p('Raise complaints from "My Orders" or through Help &amp; Support. Escalation options are described in the <a href="/grievance-policy">Grievance &amp; Legal Policy</a>.')),
      s('Account Suspension', p('We may suspend accounts involved in fraud, abuse, payment chargeback misuse or repeated breaches of our policies.')),
    ],
  },

  // ─── D. PARTNER ───────────────────────────────────────────────────────────
  {
    slug: 'partner-policy', publicPath: '/partner-policy', policyType: 'PARTNER', category: 'Partners', sortOrder: 4,
    title: 'Partner Policy',
    description: 'Eligibility, conduct, commission, payout and discipline rules for service partners and agencies.',
    seoTitle: 'Partner Policy | Remont India',
    seoDescription: 'Rules for Remont India service partners and agencies: eligibility, KYC, conduct, commission, payouts and penalties.',
    sections: [
      s('Partner Eligibility', p('Partners must be at least 18 years old, legally able to work in India, have the skills for the categories they select and ' + ph('any other eligibility requirement') + '.')),
      s('Registration', p('Registration requires an OTP-verified mobile number, service categories, a GPS location within India and acceptance of the background-check consent, commission and service-standards agreements.')),
      s('KYC', p('Partners must upload the identity and other documents requested during registration. Documents are used only for verification, compliance and payouts.')),
      s('Verification', p('Applications are reviewed by our team, which may approve, reject, place on hold or request more documents. Only approved Partners receive jobs.') + VERIFICATION_STATUS),
      s('Partner Conduct', p('Be punctual, courteous and honest; wear identification if provided; never ask customers for their account OTP; never take payment for platform jobs outside the platform.')),
      s('Customer Interaction', p('Use customer contact details only for the assigned job. Get customer approval, through the platform, before adding extra work or changing the price.')),
      s('Service Quality', p('Confirm job start and completion with the customer\'s one-time codes. Jobs found to be substandard may need to be redone at no extra charge under the applicable workmanship warranty.')),
      s('Attendance', p(ph('Attendance / availability expectations for partners'))),
      s('Cancellation', p(ph('Rules and consequences when a partner cancels an accepted job'))),
      s('No-Show', p(ph('Rules and consequences when a partner does not arrive for an accepted job'))),
      s('Commission', p('The platform commission applicable to your jobs is the rate agreed at registration or as updated with notice: ' + ph('commission rate(s) or where they are published') + '.')),
      s('Payout', p('Earnings from completed jobs are credited to your partner wallet. Withdrawal requests are reviewed and approved by our team before payment to your registered bank account. ' + ph('Payout schedule'))),
      s('Wallet', p('The partner wallet shows earnings, adjustments and withdrawals. Adjustments made by our team are recorded with a reason.')),
      s('Incentives', p(ph('Incentive or bonus programmes, if any'))),
      s('Penalties', p(ph('Penalty schedule, if any — do not publish amounts until approved'))),
      s('Suspension', p('Partners may be suspended or frozen during an investigation into complaints, fraud, safety issues or policy breaches.')),
      s('Termination', p('We may end a Partner\'s access for serious or repeated breaches. Earnings already due are settled after deducting any amounts legitimately owed.')),
      s('Dispute Resolution', p('Raise disputes about jobs, earnings or deductions with partner support. Escalation is described in the <a href="/grievance-policy">Grievance &amp; Legal Policy</a>.')),
    ],
  },

  // ─── E. SELLER ────────────────────────────────────────────────────────────
  {
    slug: 'seller-policy', publicPath: '/seller-policy', policyType: 'SELLER', category: 'Sellers', sortOrder: 5,
    title: 'Seller Policy',
    description: 'Registration, listing, fulfilment, returns and settlement rules for product sellers.',
    seoTitle: 'Seller Policy | Remont India',
    seoDescription: 'Rules for Remont India product sellers: KYC, GST, listings, fulfilment, returns, commission and settlements.',
    sections: [
      s('Seller Registration', p('Registration requires business and owner details, an OTP-verified mobile number, at least one pickup location and bank account details, followed by review by our team.')),
      s('Seller KYC', p('Sellers must provide the identity and business documents requested during registration.')),
      s('GST / Tax Information', p('Sellers are responsible for providing correct GST details and for their own tax compliance. Tax collected at source (TCS) and other statutory deductions are applied where the law requires.')),
      s('Product Listing', p('List only products you are authorised to sell, in the correct category, with accurate specifications.')),
      s('Product Information', p('Titles, images, prices, warranty terms and specifications must be accurate and not misleading.')),
      s('Inventory', p('Keep stock levels current. Orders are only accepted against available stock.')),
      s('Pricing', p('Sellers set product prices within the rules of the platform. Prices shown to customers include or exclude GST as displayed at checkout.')),
      s('Order Fulfilment', p('Pack and hand over orders for dispatch within ' + ph('dispatch time') + '.')),
      s('Shipping', p('Orders are delivered by the assigned delivery partner; delivery is confirmed with a one-time code.')),
      s('Cancellation', p(ph('Seller-initiated cancellation rules and consequences'))),
      s('Return', p('For return requests, the Seller may give a recommendation and {{COMPANY_NAME}} makes the final decision. ' + ph('Return window for products'))),
      s('Refund', REFUND_REVIEW),
      s('Replacement', p(ph('Replacement rules for faulty / damaged / wrong items'))),
      s('Warranty', p('Sellers must honour the manufacturer or seller warranty stated on the listing.')),
      s('Commission', p(ph('Commission / platform fee structure for sellers or where it is published'))),
      s('Settlement', p('Amounts due for delivered orders are settled to the registered bank account after the applicable return period, less commission, fees and statutory deductions. ' + ph('Settlement cycle'))),
      s('Penalties', p(ph('Penalty schedule, if any — do not publish amounts until approved'))),
      s('Suspension', p('Seller accounts may be suspended during investigation of complaints, counterfeit listings or policy breaches.')),
      s('Termination', p('We may end a Seller\'s access for serious or repeated breaches; pending settlements are handled after deducting amounts legitimately owed.')),
    ],
  },

  // ─── F. REFUND & CANCELLATION ─────────────────────────────────────────────
  {
    slug: 'refund-cancellation-policy', publicPath: '/refund-policy', policyType: 'REFUND', category: 'Payments', sortOrder: 6,
    title: 'Refund & Cancellation Policy',
    description: 'How cancellations work and how refund requests are reviewed and resolved.',
    seoTitle: 'Refund & Cancellation Policy | Remont India',
    seoDescription: 'How cancellations work at Remont India and how refund requests are reviewed and resolved.',
    sections: [
      s('Customer Cancellation', p('You can cancel an order yourself from "My Orders" at any time before the assigned professional starts work. Once a job is marked "Started" or later, self-service cancellation is no longer available — contact support for exceptional circumstances.')),
      s('Service Cancellation', p(ph('Any cancellation or visit charge for service bookings — leave blank if none'))),
      s('Product Cancellation', p(ph('Product order cancellation rules before / after dispatch'))),
      s('Partner Cancellation', p('If a Partner cancels, we will try to assign another Partner. If no Partner is available you may cancel without charge.')),
      s('Seller Cancellation', p('If a Seller cannot fulfil a product order, the order is cancelled and any online payment is refunded as described below.')),
      s('Refund Eligibility', p('Refunds are never automatic. Raise a request from the order (Payment Details → Raise a Refund Request) with a description and any photos. Our support team reviews every request, may ask the Partner or Seller to respond, and decides case by case. Possible outcomes are:') + ul(
        '<strong>Wallet credit</strong> — the default outcome for most approved refunds.',
        '<strong>Partial wallet + gateway refund</strong> — where part of the order is retained.',
        '<strong>Full gateway refund</strong> — in exceptional cases, only where the original payment was made online.',
        '<strong>Free rework</strong> — the job is redone at no extra cost.',
        '<strong>Discount coupon</strong> — for a future booking.',
        '<strong>No refund</strong> — where the request is not substantiated.',
      )),
      s('Partial Refund', p('Where part of a service or order was delivered (for example materials already used), only the undelivered portion may be refunded.')),
      s('Failed Payment Refund', p('If money was debited but the payment failed or the order was not created, the amount is normally reversed by the payment gateway or bank. If it is not, contact support with the transaction reference.')),
      s('Duplicate Payment', p('If you were charged more than once for the same order, contact support with the transaction references; the duplicate amount will be refunded after verification.')),
      s('Refund Processing', p('Wallet credits are applied as soon as a refund decision is approved. Refunds to the original payment method follow the payment gateway\'s and bank\'s processing timelines, which are outside our control. ' + ph('Typical gateway refund timeline to state, if any'))),
      s('Wallet / Credit Refund', p('Orders paid by cash, UPI or card at the door are refunded as Remont Wallet credit, because there is no online payment to reverse. Wallet balance can be used on future orders.')),
      s('Force Majeure', p('We are not responsible for delays or cancellations caused by events beyond reasonable control, such as natural disasters, government restrictions or widespread outages. Affected bookings will be rescheduled or cancelled without charge.')),
    ],
  },

  // ─── G. PAYMENT ───────────────────────────────────────────────────────────
  {
    slug: 'payment-policy', publicPath: '/payment-policy', policyType: 'PAYMENT', category: 'Payments', sortOrder: 7,
    title: 'Payment Policy',
    description: 'Accepted payment methods, confirmation, failures, invoices and GST.',
    seoTitle: 'Payment Policy | Remont India',
    seoDescription: 'Payment methods, confirmation, failed and duplicate payments, invoices and GST at Remont India.',
    sections: [
      s('Payment Methods', p('Depending on the order, you may pay online through our payment gateway (cards, UPI, net banking, wallets as supported by the gateway), by cash/UPI/card to the professional at completion, or with your Remont Wallet balance.')),
      s('Payment Processing', p('Online payments are processed by our payment gateway partner (currently Razorpay). We never see or store your full card number, CVV or UPI PIN.')),
      s('Payment Confirmation', p('A payment is confirmed only when the gateway confirms it to us. You will see the updated status in "My Orders" and receive a confirmation message.')),
      s('Failed Payment', p('If a payment fails you can retry, or choose another available method. Amounts debited for failed payments are normally reversed by the gateway or bank.')),
      s('Duplicate Payment', p('Contact support with the transaction references if you were charged twice; verified duplicate amounts are refunded.')),
      s('Refund', REFUND_REVIEW),
      s('Payment Disputes', p('Please contact support before raising a chargeback so we can resolve the issue quickly.')),
      s('Invoice', p('A GST invoice is issued for completed orders and can be downloaded from your order.')),
      s('GST', p('GST is charged at the applicable rate. Prices are shown inclusive or exclusive of GST as indicated at checkout. Business customers can provide GST details for input tax credit where supported.')),
      s('Payment Gateway', p('Your use of the payment gateway is also subject to the gateway provider\'s terms and privacy policy.')),
    ],
  },

  // ─── H. SERVICE ───────────────────────────────────────────────────────────
  {
    slug: 'service-policy', publicPath: '/service-policy', policyType: 'SERVICE', category: 'Services', sortOrder: 8,
    title: 'Service Policy',
    description: 'How home-service bookings, estimates, additional work, completion and warranty work.',
    seoTitle: 'Service Policy | Remont India',
    seoDescription: 'How Remont India home services work: booking, service area, pricing, estimates, extra work, completion, warranty and AMC.',
    sections: [
      s('Service Booking', p('Book on the website, through our AI chat assistant, on WhatsApp or by phone. A nearby approved professional is matched and assigned to your job.')),
      s('Service Area', p('Services are available only in the cities and areas shown on our website. The booking flow shows only services available for your selected city.')),
      s('Service Availability', p('Availability depends on professionals and slots in your area and may vary by service and date.')),
      s('Service Pricing', p('Published prices are shown on each service page. City-specific prices and offers may apply. Some services are priced after inspection.')),
      s('Estimates', p('Estimates from the website or AI assistant are based on the details provided and our current price list. The final price is confirmed by the assigned professional and requires your approval before work begins.')),
      s('Additional Work', p('If additional work is needed, the professional adds it to the order and it proceeds only after you approve it (confirmed with a one-time code).')),
      s('Rescheduling', p('Contact support from your order to reschedule. ' + ph('Rescheduling limits or charges, if any'))),
      s('Cancellation', p('See the <a href="/refund-policy">Refund &amp; Cancellation Policy</a>.')),
      s('Service Completion', p('Share the completion code with the professional only when the work is done to your satisfaction. An invoice is issued on completion.')),
      s('Service Quality', p('Partners are reviewed and approved by our team before they can take jobs; see "Verification" in our <a href="/partner-policy">Partner Policy</a> for what that review does and does not cover. Report quality issues from your order; we may arrange free rework where appropriate.')),
      s('Warranty', p('Where a service category carries a workmanship warranty, its period is printed on your invoice. It covers workmanship only, not spare parts or unrelated faults.')),
      s('AMC', p('Annual Maintenance Contracts cover the visits and services described in the plan purchased. ' + ph('AMC renewal, cancellation and refund terms'))),
      s('Emergency Services', p(ph('Emergency / same-day service availability and pricing, if offered'))),
    ],
  },

  // ─── I. MARKETPLACE ───────────────────────────────────────────────────────
  {
    slug: 'marketplace-policy', publicPath: '/marketplace-policy', policyType: 'MARKETPLACE', category: 'Marketplace', sortOrder: 9,
    title: 'Marketplace Policy',
    description: 'Rules that apply to every customer, partner and seller on the marketplace.',
    seoTitle: 'Marketplace Policy | Remont India',
    seoDescription: 'Rules for customers, partners and sellers using the Remont India marketplace, including prohibited products and services.',
    sections: [
      s('Marketplace Usage', PLATFORM_ROLE + p('Each participant is responsible for their own conduct and offerings.')),
      s('Customer Rules', p('See the <a href="/customer-policy">Customer Policy</a>.')),
      s('Seller Rules', p('See the <a href="/seller-policy">Seller Policy</a>.')),
      s('Partner Rules', p('See the <a href="/partner-policy">Partner Policy</a>.')),
      s('Product Rules', p('Products must be genuine, safe, legally saleable and accurately described.')),
      s('Service Rules', p('Services must be performed by approved Partners in line with the <a href="/service-policy">Service Policy</a>.')),
      s('Pricing', p('Prices must be transparent. Hidden charges and off-platform payments for platform orders are not allowed.')),
      s('Delivery', p('Product deliveries are confirmed with a one-time code at handover.')),
      s('Returns', p('Returns are handled under the <a href="/refund-policy">Refund &amp; Cancellation Policy</a> and <a href="/seller-policy">Seller Policy</a>.')),
      s('Refunds', REFUND_REVIEW),
      s('Warranty', p('Service workmanship warranty is described in the Service Policy; product warranty is as stated on the listing.')),
      s('Prohibited Products / Services', p('Illegal, counterfeit, stolen, hazardous or recalled items, and services that are unlawful or unsafe, are prohibited. ' + ph('Any additional prohibited categories'))),
      s('Unlawful Activity', UNLAWFUL_ACTIVITY),
      s('Disputes', p('Disputes between participants are first handled by our support team. See the <a href="/grievance-policy">Grievance &amp; Legal Policy</a>.') + NON_EXCLUSION),
    ],
  },

  // ─── J. GRIEVANCE & LEGAL ─────────────────────────────────────────────────
  {
    slug: 'grievance-legal-policy', publicPath: '/grievance-policy', policyType: 'GRIEVANCE', category: 'Legal', sortOrder: 10,
    title: 'Grievance & Legal Policy',
    description: 'How complaints are raised and escalated, the Grievance Officer, and legal notices.',
    seoTitle: 'Grievance & Legal Policy | Remont India',
    seoDescription: 'How to raise and escalate a complaint with Remont India, Grievance Officer contact and legal notices.',
    sections: [
      s('Customer Grievance', p('Customers can raise a complaint from the order in "My Orders", through Help &amp; Support, or by contacting {{SUPPORT_EMAIL}} / {{SUPPORT_PHONE}}.')),
      s('Partner Grievance', p('Partners can raise complaints about jobs, earnings or account actions through partner support or {{SUPPORT_EMAIL}}.')),
      s('Seller Grievance', p('Sellers can raise complaints about orders, returns or settlements through seller support or {{SUPPORT_EMAIL}}.')),
      s('Complaint Process', p('Each complaint is logged and reviewed by our team, which may contact the other party involved before reaching a decision. You will be told the outcome. ' + ph('Acknowledgement and resolution timelines'))),
      s('Escalation', p('If you are not satisfied with the resolution, escalate to the Grievance Officer below with your order or case reference.')),
      s('Grievance Officer', p('Name and designation: {{GRIEVANCE_OFFICER}}<br>Email: {{GRIEVANCE_EMAIL}}<br>Address: {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}')),
      s('Company Information', p('Legal name: {{COMPANY_LEGAL_NAME}}<br>Registered address: {{COMPANY_ADDRESS}}<br>GSTIN: {{GSTIN}}<br>Website: {{WEBSITE_URL}}')),
      s('Legal Notices', p('Legal notices must be sent in writing to {{COMPANY_LEGAL_NAME}}, {{COMPANY_ADDRESS}}, with a copy to {{GRIEVANCE_EMAIL}}.')),
      s('Dispute Resolution', p(ph('Dispute resolution mechanism beyond internal escalation (e.g. mediation / arbitration), if any'))),
      s('Governing Law', p('Governed by the laws of India. See the <a href="/terms">Terms &amp; Conditions</a> for jurisdiction.')),
      s('Contact', CONTACT),
    ],
  },

  // ─── K. COOKIE & TECHNOLOGY ───────────────────────────────────────────────
  {
    slug: 'cookie-technology-policy', publicPath: '/cookie-policy', policyType: 'COOKIE', category: 'Privacy', sortOrder: 11,
    title: 'Cookie & Technology Policy',
    description: 'Browser storage, device information, location and third-party technologies used by the website.',
    seoTitle: 'Cookie & Technology Policy | Remont India',
    seoDescription: 'How Remont India uses browser storage, location, notifications and third-party services on its website.',
    sections: [
      s('Cookies', p('Our website does not use advertising or third-party tracking cookies. Third-party services embedded in a page (for example the payment checkout or a map) may set their own cookies under their own policies.')),
      s('Local Storage', p('We use your browser\'s local storage to keep you signed in and to remember preferences such as your selected city, cart and recently used address. Clearing your browser data removes these.')),
      s('Analytics', p('We do not currently use third-party web analytics on the website. If this changes, this section will be updated before it is enabled.')),
      s('Device Information', p('Our servers receive standard technical information such as IP address and browser type with each request, used for security, rate-limiting and troubleshooting. If you allow browser notifications, a push-notification token for your device is stored so we can send order updates.')),
      s('Location Services', p('Location is requested only with your permission and only to fill in your address, suggest a serviced city or, for partners, record the work location. You can refuse and enter your address manually.')),
      s('Maps', p('Maps on our pages are displayed using OpenStreetMap, and addresses may be looked up using an OpenStreetMap-based geocoding service. "Navigate" links open Google Maps in a new tab with only the destination coordinates.')),
      s('Third-Party Services', p('We rely on service providers for specific functions:') + ul(
        'Payment processing — Razorpay and PhonePe.',
        'Push notifications — Firebase Cloud Messaging (Google).',
        'Image hosting and optimisation — Cloudinary.',
        'SMS / WhatsApp transactional messages — MSG91.',
        'Web fonts — Google Fonts (receives your IP address when fonts load).',
        'AI chat assistant — OpenAI.',
        'Maps and geocoding — OpenStreetMap / Nominatim; Google Maps for directions links.',
      )),
      s('Security Technologies', p('We use HTTPS, OTP-based sign-in, access tokens with expiry, request rate-limiting, upload scanning and security headers that restrict what content a page can load.')),
    ],
  },

  // ─── L. AI & COMMUNICATION ────────────────────────────────────────────────
  {
    slug: 'ai-communication-policy', publicPath: '/ai-policy', policyType: 'AI', category: 'Communication', sortOrder: 12,
    title: 'AI & Communication Policy',
    description: 'How the AI assistant and messaging channels (WhatsApp, Messenger, Instagram) are used.',
    seoTitle: 'AI & Communication Policy | Remont India',
    seoDescription: 'How Remont India uses an AI assistant and messaging channels like WhatsApp, Messenger and Instagram, and when a human takes over.',
    sections: [
      s('AI Assistant', p('Our website chat assistant, and assistants on connected messaging channels, use AI to help you find services, check coverage, get estimates and start bookings or registrations. The assistant is software — not a human and not a technician — and you are told when you are talking to it.')),
      s('Automated Responses', p('The assistant answers using our live catalogue, prices, service areas and FAQs. It is instructed not to quote prices or availability without looking them up.')),
      s('Customer Conversations', p('Your messages and the assistant\'s replies are stored so that our team can follow up, improve answers and resolve disputes.')),
      s('WhatsApp', p('We use WhatsApp to send transactional updates and to answer messages you send to our WhatsApp Business number, which may first be handled by the AI assistant.')),
      s('Facebook Messenger', p('Messages sent to our Facebook Page may be answered by the AI assistant and our team. ' + ph('Confirm Messenger is connected'))),
      s('Instagram', p('Direct messages sent to our Instagram professional account may be answered by the AI assistant and our team. ' + ph('Confirm Instagram is connected'))),
      s('Lead Qualification', p('The assistant may ask for details such as service needed, city and preferred time, create or update an enquiry (lead) in our CRM, and summarise the conversation so our team can follow up.')),
      s('Human Handoff', p('You can ask for a person at any time. Conversations are also handed to our team when the assistant cannot help, or for refunds, complaints, disputes and account issues.')),
      s('AI Limitations', p('AI responses may contain errors. Estimates are indicative until confirmed by the assigned professional, and the assistant does not make final decisions on refunds, disputes, suspensions or payouts.')),
      s('Data Processing', p('Messages sent to the assistant are processed by a third-party AI model provider (currently OpenAI) on our behalf to generate replies. See our <a href="/privacy">Privacy Policy</a> for retention and your rights.')),
    ],
  },
];

export const SYSTEM_SLUGS = POLICY_TEMPLATES.map((t) => t.slug);
export const SYSTEM_PUBLIC_PATHS = POLICY_TEMPLATES.map((t) => t.publicPath);
