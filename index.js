import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import cors from 'cors';
import Stripe from 'stripe';
import dotenv from 'dotenv';
import { resolveMongoUri } from './resolve-mongo-uri.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 5000;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}


const allowedOrigins = [
  'http://localhost:3000',
  'https://promet-veres-system.vercel.app', // আপনার প্রোডাকশন ফ্রন্টএন্ড URL
  process.env.CLIENT_URL
].filter(Boolean); // undefined বা empty মান ফিল্টার করার জন্য

console.log('Stripe configured:', Boolean(getStripe()));

app.use(cors({
  origin: function (origin, callback) {
    // Postman, Server-to-server বা origin ছাড়া রিকোয়েস্ট অ্যালাউ করার জন্য (!origin)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS Policy: Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Stripe webhook needs raw body — must be registered before express.json()
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).send({ message: "Stripe is not configured" });
  }

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_email || session.metadata?.email;

    if (email) {
      await usersCollection.updateOne(
        { email },
        { $set: { isPremium: true } }
      );

      await paymentsCollection.insertOne({
        transactionId: session.id,
        email,
        amount: (session.amount_total || 500) / 100,
        date: new Date(),
        status: 'completed',
      });
    }
  }

  res.send({ received: true });
});

app.use(express.json());

let client;
let promptsCollection;
let usersCollection;
let bookmarksCollection;
let reviewsCollection;
let reportsCollection;
let paymentsCollection;


const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || "http://localhost:3000";
console.log("AUTH_SERVER_URL is set to:", AUTH_SERVER_URL);

let _jwks;
const getJWKS = (forceRefresh = false) => {
  if (!_jwks || forceRefresh) {
    _jwks = createRemoteJWKSet(new URL(`${AUTH_SERVER_URL}/api/auth/jwks`), {
      cooldownDuration: 0,
    });
  }
  return _jwks;
};

async function findUserFromDecoded(decoded) {
  if (!decoded) return null;

  if (decoded.email) {
    const byEmail = await usersCollection.findOne({ email: decoded.email });
    if (byEmail) return byEmail;
  }

  if (decoded.sub && ObjectId.isValid(String(decoded.sub))) {
    return usersCollection.findOne({ _id: new ObjectId(String(decoded.sub)) });
  }

  return null;
}

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  const attachUser = async (payload) => {
    const user = await findUserFromDecoded(payload);

    req.decoded = {
      ...payload,
      email: user?.email || payload.email,
      role: user?.role || payload.role,
      sub: payload.sub,
    };
  };

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: AUTH_SERVER_URL,
      audience: AUTH_SERVER_URL,
    });
    await attachUser(payload);
    next();
  } catch (err) {
    try {
      const { payload } = await jwtVerify(token, getJWKS(true), {
        issuer: AUTH_SERVER_URL,
        audience: AUTH_SERVER_URL,
      });
      await attachUser(payload);
      return next();
    } catch (retryErr) {
      console.error("JWT verify failed:", retryErr.message);
      return res.status(403).send({ message: "Forbidden access" });
    }
  }
};

// ---- verifyAdmin ----
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded?.email;
  if (!email) {
    return res.status(403).send({ message: "Admin access only" });
  }

  const user = await usersCollection.findOne({ email });

  if (user?.role !== "admin") {
    return res.status(403).send({ message: "Admin access only" });
  }
  next();
};

async function connectDB() {
  const mongoUri = await resolveMongoUri(process.env.MONGO_DB_URI);
  client = new MongoClient(mongoUri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  await client.connect();
  promptsCollection = client.db("Prompt_Verse").collection("prompts");
  usersCollection = client.db("Prompt_Verse").collection("user"); // better-auth ডিফল্ট কালেকশন নাম
  bookmarksCollection = client.db("Prompt_Verse").collection("bookmarks");
  reviewsCollection = client.db("Prompt_Verse").collection("reviews");
  reportsCollection = client.db("Prompt_Verse").collection("reports");
  paymentsCollection = client.db("Prompt_Verse").collection("payments");
  console.log("Connected to MongoDB!");
}

// ===================== Routes =====================

// ---- GET /api/prompts/featured ----
app.get('/api/prompts/featured', async (req, res) => {
  try {
    const featured = await promptsCollection
      .find({ status: "approved", visibility: "public", isFeatured: true })
      .sort({ rating: -1, copyCount: -1 })
      .limit(6)
      .toArray();

    if (featured.length >= 6) {
      return res.send(featured);
    }

    const remaining = 6 - featured.length;
    const featuredIds = featured.map((p) => p._id);

    const trending = await promptsCollection
      .find({
        status: "approved",
        visibility: "public",
        _id: { $nin: featuredIds },
      })
      .sort({ rating: -1, copyCount: -1 })
      .limit(remaining)
      .toArray();

    res.send([...featured, ...trending]);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Error fetching featured prompts" });
  }
});

// ---- GET /api/creators/top ----
app.get('/api/creators/top', async (req, res) => {
  try {
    const result = await promptsCollection
      .aggregate([
        { $match: { status: "approved", visibility: "public" } },
        {
          $group: {
            _id: "$creatorId",
            totalPrompts: { $sum: 1 },
            totalCopies: { $sum: "$copyCount" },
          },
        },
        { $sort: { totalCopies: -1 } },
        { $limit: 3 },
        {
          $addFields: {
            creatorObjectId: {
              $convert: {
                input: "$_id",
                to: "objectId",
                onError: null,
                onNull: null,
              },
            },
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "creatorObjectId",
            foreignField: "_id",
            as: "creator",
          },
        },
        { $unwind: { path: "$creator", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            totalPrompts: 1,
            totalCopies: 1,
            name: { $ifNull: ["$creator.name", "Unknown Creator"] },
            image: "$creator.image",
            role: { $ifNull: ["$creator.role", "creator"] },
          },
        },
      ])
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load top creators" });
  }
});

// ---- POST /api/prompts ----
app.post('/api/prompts', verifyToken, async (req, res) => {
  try {
    const promptData = req.body;
    const tokenEmail = req.decoded.email;

    if (promptData.creatorEmail !== tokenEmail) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    // ---- Free user হলে সর্বোচ্চ ৩টা prompt-এর সীমা চেক ----
    const creator = await usersCollection.findOne({ email: tokenEmail });
    const isPremium = creator?.isPremium === true;

    if (!isPremium) {
      const existingCount = await promptsCollection.countDocuments({
        creatorEmail: tokenEmail,
      });
      if (existingCount >= 3) {
        return res.status(403).send({
          message: "Free users can add a maximum of 3 prompts. Upgrade to Premium for unlimited prompts.",
        });
      }
    }

    const newPrompt = {
      ...promptData,
      copyCount: 0,
      status: "pending",
      rating: 0,
      createdAt: new Date(),
    };

    const result = await promptsCollection.insertOne(newPrompt);
    res.status(201).send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to create prompt" });
  }
});

// ---- GET /api/prompts ----
app.get('/api/prompts', async (req, res) => {
  try {
    const {
      search = "",
      category = "All",
      aiTool = "All",
      difficulty = "All",
      sort = "latest", // latest | popular | copied
      page = 1,
      limit = 6,
    } = req.query;

    const query = { status: "approved", visibility: { $ne: "private-hidden" } };

    if (search.trim()) {
      const regex = new RegExp(search.trim(), "i");
      query.$or = [{ title: regex }, { tags: regex }, { aiTool: regex }];
    }

    if (category !== "All") query.category = category;
    if (aiTool !== "All") query.aiTool = aiTool;
    if (difficulty !== "All") query.difficulty = difficulty;

    // ---- Sort mapping ----
    const sortMap = {
      latest: { createdAt: -1 },
      popular: { rating: -1 },
      copied: { copyCount: -1 },
    };
    const sortQuery = sortMap[sort] || sortMap.latest;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const totalCount = await promptsCollection.countDocuments(query);
    const prompts = await promptsCollection
      .find(query)
      .sort(sortQuery)
      .skip(skip)
      .limit(limitNum)
      .toArray();

    res.send({
      prompts,
      totalCount,
      totalPages: Math.ceil(totalCount / limitNum),
      currentPage: pageNum,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load prompts" });
  }
});

// ---- GET /api/prompts/my-prompts ----
app.get('/api/prompts/my-prompts', verifyToken, async (req, res) => {
  try {
    const result = await promptsCollection
      .find({ creatorEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load your prompts" });
  }
});

// ---- PATCH /api/prompts/:id ----
app.patch('/api/prompts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const existingPrompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
    if (!existingPrompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }
    if (existingPrompt.creatorEmail !== req.decoded.email) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    const updateData = { ...req.body };
    delete updateData._id;
    delete updateData.copyCount;
    updateData.status = "pending";

    const result = await promptsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update prompt" });
  }
});

// ---- DELETE /api/prompts/:id ----
app.delete('/api/prompts/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const existingPrompt = await promptsCollection.findOne({ _id: new ObjectId(id) });
    if (!existingPrompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }
    if (existingPrompt.creatorEmail !== req.decoded.email) {
      return res.status(403).send({ message: "Forbidden access" });
    }

    const result = await promptsCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to delete prompt" });
  }
});

// ---- POST /api/bookmarks ----
app.post('/api/bookmarks', verifyToken, async (req, res) => {
  try {
    const { promptId } = req.body;
    const email = req.decoded.email;

    const existing = await bookmarksCollection.findOne({ promptId, email });

    if (existing) {
      await bookmarksCollection.deleteOne({ _id: existing._id });
      return res.send({ bookmarked: false, message: "Bookmark removed" });
    }

    await bookmarksCollection.insertOne({ promptId, email, createdAt: new Date() });
    res.send({ bookmarked: true, message: "Prompt bookmarked" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update bookmark" });
  }
});

// ---- GET /api/bookmarks ----
app.get('/api/bookmarks', verifyToken, async (req, res) => {
  try {
    const result = await bookmarksCollection
      .aggregate([
        { $match: { email: req.decoded.email } },
        {
          // promptId স্ট্রিং আকারে সেভ আছে, কিন্তু prompts._id হলো ObjectId —
          // $toObjectId দিয়ে কনভার্ট করে তারপর $lookup করতে হবে, না হলে কখনো ম্যাচ হবে না
          $addFields: { promptObjectId: { $toObjectId: "$promptId" } },
        },
        {
          $lookup: {
            from: "prompts",
            localField: "promptObjectId",
            foreignField: "_id",
            as: "prompt",
          },
        },
        { $unwind: "$prompt" },
      ])
      .toArray();

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load bookmarks" });
  }
});

// ---- GET /api/users/me ----
app.get('/api/users/me', verifyToken, async (req, res) => {
  try {
    const user = await findUserFromDecoded(req.decoded);
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    const totalPrompts = await promptsCollection.countDocuments({
      creatorEmail: user.email,
    });

    res.send({
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role || "user",
      isPremium: user.isPremium === true,
      totalPrompts,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load user profile" });
  }
});

// ---- GET /api/bookmarks/check/:promptId ----
app.get('/api/bookmarks/check/:promptId', verifyToken, async (req, res) => {
  try {
    const { promptId } = req.params;
    const existing = await bookmarksCollection.findOne({
      promptId,
      email: req.decoded.email,
    });
    res.send({ bookmarked: !!existing });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to check bookmark status" });
  }
});

// ---- GET /api/reviews/my-reviews ----
app.get('/api/reviews/my-reviews', verifyToken, async (req, res) => {
  try {
    const result = await reviewsCollection
      .find({ reviewerEmail: req.decoded.email })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load your reviews" });
  }
});

// ---- GET /api/reviews/recent ----
app.get('/api/reviews/recent', async (req, res) => {
  try {
    const result = await reviewsCollection
      .find()
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load recent reviews" });
  }
});

// ---- POST /api/reviews ----
app.post('/api/reviews', verifyToken, async (req, res) => {
  try {
    const { promptId, rating, comment } = req.body;

    if (!promptId || !rating || !comment?.trim()) {
      return res.status(400).send({ message: "promptId, rating, and comment are required" });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).send({ message: "Rating must be between 1 and 5" });
    }
    if (!ObjectId.isValid(promptId)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const prompt = await promptsCollection.findOne({ _id: new ObjectId(promptId) });
    if (!prompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }

    const user = await usersCollection.findOne({ email: req.decoded.email });

    const existingReview = await reviewsCollection.findOne({
      promptId,
      reviewerEmail: req.decoded.email,
    });
    if (existingReview) {
      return res.status(400).send({ message: "You have already reviewed this prompt" });
    }

    const review = {
      promptId,
      promptTitle: prompt.title,
      reviewerEmail: req.decoded.email,
      reviewerName: user?.name || "Anonymous",
      rating: Number(rating),
      comment: comment.trim(),
      createdAt: new Date(),
    };

    await reviewsCollection.insertOne(review);

    const ratingAgg = await reviewsCollection
      .aggregate([
        { $match: { promptId } },
        { $group: { _id: null, avgRating: { $avg: "$rating" } } },
      ])
      .toArray();

    const avgRating = ratingAgg[0]?.avgRating || rating;
    await promptsCollection.updateOne(
      { _id: new ObjectId(promptId) },
      { $set: { rating: Math.round(avgRating * 10) / 10 } }
    );

    res.status(201).send(review);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to submit review" });
  }
});

// ---- GET /api/reviews/:promptId ----
app.get('/api/reviews/:promptId', async (req, res) => {
  try {
    const { promptId } = req.params;
    if (!ObjectId.isValid(promptId)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const result = await reviewsCollection
      .find({ promptId })
      .sort({ createdAt: -1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load reviews" });
  }
});

// ---- POST /api/reports ----
app.post('/api/reports', verifyToken, async (req, res) => {
  try {
    const { promptId, reason, description } = req.body;

    if (!promptId || !reason) {
      return res.status(400).send({ message: "promptId and reason are required" });
    }
    if (!ObjectId.isValid(promptId)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const prompt = await promptsCollection.findOne({ _id: new ObjectId(promptId) });
    if (!prompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }

    const report = {
      promptId: new ObjectId(promptId),
      reason,
      description: description?.trim() || "",
      reporterEmail: req.decoded.email,
      status: "pending",
      createdAt: new Date(),
    };

    await reportsCollection.insertOne(report);
    res.status(201).send({ message: "Report submitted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to submit report" });
  }
});

// ---- POST /api/payments/create-checkout-session ----
app.post('/api/payments/create-checkout-session', verifyToken, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).send({ message: "Stripe is not configured" });
    }

    const user = await findUserFromDecoded(req.decoded);
    if (!user) {
      return res.status(404).send({ message: "User not found" });
    }

    if (user?.isPremium) {
      return res.status(400).send({ message: "You already have Premium access" });
    }

    const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
    const userEmail = user.email;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: userEmail,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'PromptVerse Premium',
              description: 'Unlock all private/premium prompts',
            },
            unit_amount: 500,
          },
          quantity: 1,
        },
      ],
      metadata: { email: userEmail },
      success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/payment`,
    });

    res.send({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error("Stripe checkout error:", error.message);
    res.status(500).send({ message: error.message || "Failed to create checkout session" });
  }
});

// ---- GET /api/payments/verify-session ----
// Stripe webhook ছাড়া local/dev-এ premium activate করার fallback
app.get('/api/payments/verify-session', verifyToken, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      return res.status(503).send({ message: "Stripe is not configured" });
    }

    const { session_id: sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).send({ message: "session_id is required" });
    }

    const session = await stripe.checkout.sessions.retrieve(String(sessionId));
    if (session.payment_status !== "paid") {
      return res.status(400).send({ message: "Payment not completed yet" });
    }

    const resolvedEmail =
      session.customer_email ||
      session.metadata?.email ||
      req.decoded.email ||
      (await findUserFromDecoded(req.decoded))?.email;

    if (!resolvedEmail) {
      return res.status(400).send({ message: "Could not resolve user email" });
    }

    await usersCollection.updateOne(
      { email: resolvedEmail },
      { $set: { isPremium: true } }
    );

    const existingPayment = await paymentsCollection.findOne({
      transactionId: session.id,
    });

    if (!existingPayment) {
      await paymentsCollection.insertOne({
        transactionId: session.id,
        email: resolvedEmail,
        amount: (session.amount_total || 500) / 100,
        date: new Date(),
        status: "completed",
      });
    }

    res.send({ isPremium: true, email: resolvedEmail });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to verify payment session" });
  }
});

// ---- GET /api/prompts/:id ----
// Prompt Details পেজের জন্য — একটা single prompt তার সব ডিটেইল সহ
app.get('/api/prompts/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });

    if (!prompt) {
      return res.status(404).send({ message: "Prompt not found" });
    }

    res.send(prompt);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load prompt details" });
  }
});

// ---- PATCH /api/prompts/:id/copy ----
// Copy Prompt বাটনে ক্লিক করলে কপি কাউন্ট ১ বাড়াবে
app.patch('/api/prompts/:id/copy', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: "Invalid prompt id" });
    }

    const result = await promptsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $inc: { copyCount: 1 } }
    );

    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update copy count" });
  }
});

// ===================== Admin Routes =====================

// ---- GET /api/admin/users ----
app.get('/api/admin/users', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const totalCount = await usersCollection.countDocuments();
    const users = await usersCollection
      .find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      users,
      totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
      currentPage: page,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load users" });
  }
});

// ---- PATCH /api/admin/users/:id/role ----
app.patch('/api/admin/users/:id/role', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["user", "creator", "admin"].includes(role)) {
      return res.status(400).send({ message: "Invalid role" });
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { role } }
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update role" });
  }
});

// ---- DELETE /api/admin/users/:id ----
app.delete('/api/admin/users/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to delete user" });
  }
});

// ---- GET /api/admin/prompts ----
// সব prompt — যেকোনো status (pending/approved/rejected) — অ্যাডমিন রিভিউ করার জন্য
app.get('/api/admin/prompts', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const totalCount = await promptsCollection.countDocuments();
    const prompts = await promptsCollection
      .find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.send({
      prompts,
      totalCount,
      totalPages: Math.ceil(totalCount / limit) || 1,
      currentPage: page,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load prompts" });
  }
});

// ---- PATCH /api/admin/prompts/:id/status ----
// Approve / Reject (reject হলে feedback আবশ্যক — doc অনুযায়ী)
app.patch('/api/admin/prompts/:id/status', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, feedback } = req.body;

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).send({ message: "Invalid status" });
    }
    if (status === "rejected" && !feedback) {
      return res.status(400).send({ message: "Rejection feedback is required" });
    }

    const updateDoc = { status };
    if (status === "rejected") updateDoc.rejectionFeedback = feedback;

    const result = await promptsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update prompt status" });
  }
});

// ---- PATCH /api/admin/prompts/:id/feature ----
app.patch('/api/admin/prompts/:id/feature', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const prompt = await promptsCollection.findOne({ _id: new ObjectId(id) });

    const result = await promptsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { isFeatured: !prompt?.isFeatured } }
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update feature status" });
  }
});

// ---- DELETE /api/admin/prompts/:id ----
app.delete('/api/admin/prompts/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await promptsCollection.deleteOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to delete prompt" });
  }
});

// ---- GET /api/admin/payments ----
app.get('/api/admin/payments', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const payments = await paymentsCollection.find().sort({ date: -1 }).toArray();
    res.send(payments);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load payments" });
  }
});

// ---- GET /api/admin/reports ----
app.get('/api/admin/reports', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const reports = await reportsCollection
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "prompts",
            localField: "promptId",
            foreignField: "_id",
            as: "prompt",
          },
        },
        { $unwind: { path: "$prompt", preserveNullAndEmptyArrays: true } },
      ])
      .toArray();
    res.send(reports);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load reports" });
  }
});

// ---- PATCH /api/admin/reports/:id ----
// action: "remove" (prompt ডিলিট করবে) | "warn" (creator-কে warn করবে — placeholder) | "dismiss"
app.patch('/api/admin/reports/:id', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const report = await reportsCollection.findOne({ _id: new ObjectId(id) });
    if (!report) return res.status(404).send({ message: "Report not found" });

    if (action === "remove" && report.promptId) {
      await promptsCollection.deleteOne({ _id: new ObjectId(report.promptId) });
    }

    const result = await reportsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: action } } // "remove" | "warn" | "dismiss"
    );
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to update report" });
  }
});

// ---- GET /api/admin/analytics ----
app.get('/api/admin/analytics', verifyToken, verifyAdmin, async (req, res) => {
  try {
    const totalUsers = await usersCollection.estimatedDocumentCount();
    const totalPrompts = await promptsCollection.estimatedDocumentCount();
    const totalReviews = await reviewsCollection.estimatedDocumentCount();

    const copyAgg = await promptsCollection
      .aggregate([{ $group: { _id: null, totalCopies: { $sum: "$copyCount" } } }])
      .toArray();

    res.send({
      totalUsers,
      totalPrompts,
      totalReviews,
      totalCopies: copyAgg[0]?.totalCopies || 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load analytics" });
  }
});

// ===================== Creator Routes =====================

// ---- GET /api/creator/analytics ----
// লগইন করা creator-এর নিজের summary cards + চার্টের ডেটা
app.get('/api/creator/analytics', verifyToken, async (req, res) => {
  try {
    const email = req.decoded.email;

    const myPrompts = await promptsCollection.find({ creatorEmail: email }).toArray();

    const totalPrompts = myPrompts.length;
    const totalCopies = myPrompts.reduce((sum, p) => sum + (p.copyCount || 0), 0);

    const promptIds = myPrompts.map((p) => p._id.toString());
    const totalBookmarks = await bookmarksCollection.countDocuments({
      promptId: { $in: promptIds },
    });

    // ---- Prompt growth: মাস অনুযায়ী কতগুলো prompt যুক্ত হয়েছে (চার্টের জন্য) ----
    const growthMap = {};
    myPrompts.forEach((p) => {
      const month = new Date(p.createdAt).toLocaleString("en-US", {
        month: "short",
        year: "2-digit",
      });
      growthMap[month] = (growthMap[month] || 0) + 1;
    });
    const promptGrowth = Object.entries(growthMap).map(([month, count]) => ({
      month,
      count,
    }));

    // ---- Copies per prompt (চার্টের জন্য) ----
    const copiesByPrompt = myPrompts.map((p) => ({
      title: p.title?.slice(0, 18) || "Untitled",
      copies: p.copyCount || 0,
    }));

    res.send({ totalPrompts, totalCopies, totalBookmarks, promptGrowth, copiesByPrompt });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to load creator analytics" });
  }
});

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Initialize server
connectDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}).catch(console.dir);