const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { jwtVerify, createRemoteJWKSet } = require('jose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true, // session cookie পাঠানোর জন্য জরুরি — wildcard "*" দিয়ে এটা কাজ করবে না
}));
app.use(express.json());

const client = new MongoClient(process.env.MONGO_DB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// Use a variable to store the collection reference
let promptsCollection;
let usersCollection;
let bookmarksCollection;
let reviewsCollection;

// ---- JWKS verify middleware (better-auth jwt plugin) ----
// JWT_SECRET-এর বদলে এখন Next.js অ্যাপের /api/auth/jwks থেকে public key এনে verify করে।
// ⚠️ lazy-init করা হচ্ছে (top-level এ না) যাতে env var মিসিং থাকলে পুরো সার্ভার ক্র্যাশ না করে,
// শুধু protected রুটে রিকোয়েস্ট এলে error দেখাবে — debug করা সহজ হবে।
const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || "http://localhost:3000";
console.log("AUTH_SERVER_URL is set to:", AUTH_SERVER_URL); // স্টার্টআপে চেক করার জন্য

let _jwks;
const getJWKS = () => {
  if (!_jwks) {
    _jwks = createRemoteJWKSet(new URL(`${AUTH_SERVER_URL}/api/auth/jwks`));
  }
  return _jwks;
};

const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "Unauthorized access" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const { payload } = await jwtVerify(token, getJWKS());
    req.decoded = payload; // { email, sub, ... } — better-auth ডিফল্টে যা পাঠায়
    next();
  } catch (err) {
    console.error("JWT verify failed:", err.message);
    return res.status(403).send({ message: "Forbidden access" });
  }
};

async function connectDB() {
  await client.connect();
  promptsCollection = client.db("Prompt_Verse").collection("prompts");
  usersCollection = client.db("Prompt_Verse").collection("user"); // better-auth ডিফল্ট কালেকশন নাম
  bookmarksCollection = client.db("Prompt_Verse").collection("bookmarks");
  reviewsCollection = client.db("Prompt_Verse").collection("reviews");
  console.log("Connected to MongoDB!");
}

// ===================== Routes =====================

// ---- GET /api/prompts/featured ----
// Home page-এর জন্য ৬টা featured/trending prompt — approved + public হতে হবে
app.get('/api/prompts/featured', async (req, res) => {
  try {
    const result = await promptsCollection
      .find({ status: "approved", visibility: "public" })
      .sort({ rating: -1, copyCount: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Error fetching featured prompts" });
  }
});

// ---- GET /api/creators/top ----
// MongoDB aggregation: prompts collection-এ creatorId দিয়ে গ্রুপ করে total prompts +
// total copies বের করা হয়, তারপর $lookup দিয়ে users collection থেকে নাম/ছবি/role আনা হয়।
// ⚠️ ধরে নিচ্ছি prompts ডকুমেন্টে creatorId একটা ObjectId যা user._id-কে রেফার করে।
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
          $lookup: {
            from: "user",
            localField: "_id",
            foreignField: "_id",
            as: "creator",
          },
        },
        { $unwind: "$creator" },
        {
          $project: {
            _id: 1,
            totalPrompts: 1,
            totalCopies: 1,
            name: "$creator.name",
            image: "$creator.image",
            role: "$creator.role",
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
// নতুন prompt তৈরি — JWT দিয়ে প্রোটেক্টেড, status:"pending" + copyCount:0 ফোর্স করা হয়
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
// All Prompts পেজের জন্য — server-side search + filter + sort + pagination, সব এক রুটে
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

    // ---- Search: title, tags, aiTool — তিনটাতেই খুঁজবে ----
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
// লগইন করা ইউজারের নিজের সব prompt — JWT দিয়ে প্রোটেক্টেড
// ⚠️ এই রুট অবশ্যই /api/prompts/:id রুটের ওপরে থাকতে হবে, না হলে Express
// "my-prompts"-কে একটা :id মনে করে ভুল হ্যান্ডলারে পাঠাবে
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
// নিজের prompt আপডেট — মালিক ছাড়া কেউ আপডেট করতে পারবে না
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
    delete updateData._id; // _id কখনো ওভাররাইট করা যাবে না
    delete updateData.copyCount; // copyCount শুধু /copy রুট দিয়েই বাড়বে
    updateData.status = "pending"; // এডিট করলে আবার অ্যাডমিন রিভিউয়ে যাবে

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
// নিজের prompt ডিলিট — মালিক ছাড়া কেউ ডিলিট করতে পারবে না
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
// Bookmark টগল — আগে থেকে থাকলে রিমুভ, না থাকলে অ্যাড (duplicate প্রিভেন্ট করে)
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
// লগইন করা ইউজারের সব bookmarked prompt — bookmark + আসল prompt ডেটা একসাথে ($lookup)
app.get('/api/bookmarks', verifyToken, async (req, res) => {
  try {
    const result = await bookmarksCollection
      .aggregate([
        { $match: { email: req.decoded.email } },
        {
          $lookup: {
            from: "prompts",
            localField: "promptId",
            foreignField: "_id", // ⚠️ promptId স্ট্রিং আকারে সেভ হলে এখানে $toObjectId লাগবে — client থেকে কীভাবে পাঠানো হচ্ছে চেক করো
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

// ---- GET /api/reviews/my-reviews ----
// লগইন করা ইউজারের নিজের লেখা সব রিভিউ
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

app.get('/', (req, res) => {
  res.send('Hello World!');
});

// Initialize server
connectDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}).catch(console.dir);