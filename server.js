require("dotenv").config();
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { ImageAnnotatorClient } = require('@google-cloud/vision');  // Google Cloud Vision SDK
const { Storage } = require('@google-cloud/storage');

// Initialize Firebase Admin SDK with service account key
const serviceAccount = require("/Users/sarfrazahmad/Documents/service-account-file.json");  // Path to your Firebase service account JSON file

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "your-project-id.appspot.com",  // Use your Firebase storage bucket URL
});

// Access Firebase Firestore and Storage
const db = admin.firestore();
const storage = admin.storage();

// Initialize Google Cloud Vision client
const visionClient = new ImageAnnotatorClient();  // Using Google Vision API for processing

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIG ----------
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const STOREFRONT_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// ---------- ROOT ----------
app.get("/", (_req, res) => {
  res.send("✅ Server running. Endpoints: POST /search");
});

// ---------- SEARCH (TEXT & IMAGE) ----------
app.post("/search", upload.single("image"), async (req, res) => {
  const q = req.query.q?.trim() || "";  // Handle query from URL (for text search)
  const tmpPath = req.file?.path ? path.resolve(req.file.path) : null;  // Handle file from the form (for image search)

  try {
    // If a text query is provided, proceed with text search (you can implement text search with Shopify)
    if (q) {
      const products = await searchShopifyProducts({ query: q, first: 12 });
      return res.json({ products });
    }

    // If an image is provided, proceed with image-based search
    if (req.file) {
      const imageBuffer = fs.readFileSync(tmpPath);

      console.log("✅ Image base64 encoding successful");

      // Step 1: Use Google Vision API to analyze the image
      let labels;
      try {
        const [result] = await visionClient.labelDetection({ image: { content: imageBuffer } });
        labels = result.labelAnnotations;

        if (!labels || labels.length === 0) {
          console.error("❌ No labels found for the uploaded image.");
          return res.status(500).json({ error: "No labels found for the uploaded image from Google Vision API" });
        }

        console.log("✅ Labels from Google Vision API:", labels);
      } catch (error) {
        console.error("❌ Error analyzing image:", error);
        return res.status(500).json({ error: "Failed to analyze image using Google Vision API" });
      }

      // Step 2: Get all Shopify products (with images)
      let products;
      try {
        products = await fetchAllShopifyProducts();
      } catch (error) {
        console.error("❌ Error fetching Shopify products:", error);
        return res.status(500).json({ error: "Failed to fetch Shopify products" });
      }

      // Step 3: Compare products based on labels from Google Vision API
      const matchedProducts = [];
      for (const p of products) {
        if (!p.image) continue;

        // Match products based on labels detected in the image
        if (labels.some(label => p.title.toLowerCase().includes(label.description.toLowerCase()))) {
          matchedProducts.push(p);
        }
      }

      console.log("✅ Image similarity calculation completed");

      // Step 4: Return matched products
      if (matchedProducts.length > 0) {
        return res.json({ products: matchedProducts });
      } else {
        return res.json({ products: [] });  // No products matched
      }
    }

    // If neither text nor image is provided, return an error
    return res.status(400).json({ error: "No text or image provided for search" });

  } catch (err) {
    console.error("❌ /search error:", err.message || err);

    return res.status(500).json({ error: "Server error while searching" });
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
});

// ---------- HELPERS ----------

// Function to search Shopify products based on text query
async function searchShopifyProducts({ query, first = 12 }) {
  const gql = `
    query($query: String, $first: Int!) {
      products(query: $query, first: $first) {
        edges {
          node {
            id
            title
            descriptionHtml
            handle
            featuredImage { url altText }
            variants(first: 1) {
              edges {
                node {
                  price { amount currencyCode }
                }
              }
            }
          }
        }
      }
    }
  `;
  const resp = await axios.post(
    `https://${SHOP_DOMAIN}/api/2024-07/graphql.json`,
    { query: gql, variables: { query: query || null, first } },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": STOREFRONT_TOKEN,
      },
    }
  );
  const items = resp?.data?.data?.products?.edges || [];
  return items.map(({ node }) => ({
    title: node.title,
    description: node.descriptionHtml,
    url: `https://${SHOP_DOMAIN}/products/${node.handle}`,
    image: node.featuredImage?.url || "",
    price: node.variants?.edges?.[0]?.node?.price?.amount || "",
    currency: node.variants?.edges?.[0]?.node?.price?.currencyCode || "",
  }));
}

// Function to fetch all products from Shopify (pagination can be added for more)
async function fetchAllShopifyProducts() {
  return await searchShopifyProducts({ query: "", first: 50 });
}

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});