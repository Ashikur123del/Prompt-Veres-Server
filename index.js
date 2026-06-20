const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(require('cors')());
app.use(express.json());

const client = new MongoClient(process.env.MONGO_DB_URI, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

// Use a variable to store the collection reference
let promptsCollection;

async function connectDB() {
  await client.connect();
  promptsCollection = client.db("Prompt_Verse").collection("prompts");
  console.log("Connected to MongoDB!");
}

// Routes
app.get('/api/prompts/featured', async (req, res) => {
  try {
    const result = await promptsCollection
      .find({ status: "approved", visibility: "public" })
      .sort({ rating: -1, copyCount: -1 })
      .limit(6)
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ message: "Error fetching featured prompts" });
  }
});

// Initialize server
connectDB().then(() => {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}).catch(console.dir);