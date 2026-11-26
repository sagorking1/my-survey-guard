My Survey Control v1.3.1 – Admin Approval System
=================================================

নিয়ম:
- নতুন User  = PENDING (Script বন্ধ)
- Admin allowedIds-এ ID যোগ করলে = ACTIVE
- Admin blockedIds-এ ID যোগ করলে = BLOCKED (Block সবার আগে কাজ করে)
- GitHub থেকে config.json আনা না গেলে = VERIFICATION ERROR (ACTIVE হবে না)
- allowedIds খালি থাকলে কেউই ACTIVE হবে না

সেটআপ:
1. GitHub username (sagorking1) আগে থেকেই বসানো আছে, বদলাতে হবে না।
2. আপনার GitHub repo (my-survey-guard)-তে my-survey-control.user.js আর config.json আপলোড করুন (পুরনো ফাইল replace করুন)।
   আপনার আগের blockedIds থাকলে সেগুলো নতুন config.json-এর blockedIds-এ বসিয়ে দিন (মুছবেন না)।
3. Tampermonkey-তে my-survey-control.user.js ইনস্টল করুন।
4. Panel-এ দেখানো Access ID কপি করে config.json-এর allowedIds-এ দিন (নিজেকে Approve)।

Approve করার উদাহরণ:
  "allowedIds": ["MSC-AB12-CD34-EF56"],
  "blockedIds": ["MSC-XXXX-YYYY-ZZZZ"]

pendingIds শুধু আপনার নোট রাখার জন্য; Script এটি ব্যবহার করে না।

সীমাবদ্ধতা: এটি সাধারণ ব্যবহারকারীদের আটকায়। কেউ Script-এর কোড বদলাতে পারলে এটি বাইপাস করতে পারে। শক্ত নিরাপত্তার জন্য Server-side যাচাই লাগবে।

আপনার আগের Script-এর মূল ফিচারগুলো startProtectedFeatures() ফাংশনের ভেতরে বসাতে হবে (TODO লেখা জায়গা)।
