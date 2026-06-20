const express = require('express');
const { MongoClient, ServerApiVersion } = require('mongodb');
require('dotenv').config()
const app = express()
const cors = require('cors');
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json())



const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {

    await client.connect();

    const promptsCollection = client.db("Prompt_Verse").collection("prompts");

    // ---- GET /prompts/featured ----
    // Home page-এর জন্য ৬টা featured/trending prompt — approved + public হতে হবে
    app.get('/api/prompts/featured', async (req, res) => {
      try {
        const result = await promptsCollection
          .find({ status: "approved", visibility: "public" })
          .sort({ rating: -1, copyCount: -1 }) // সবচেয়ে জনপ্রিয়গুলো আগে
          .limit(6)
          .toArray();

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Failed to load featured prompts" });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})