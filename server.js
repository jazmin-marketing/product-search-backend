require("dotenv").config();
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const sharp = require("sharp");

// Initialize Firebase Admin SDK with service account from environment variable
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Access Firebase services
const db = admin.firestore();

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIG ----------
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ 
  dest: uploadsDir,
  limits: {
    fileSize: 50 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Cache for products to avoid repeated Shopify API calls
let productsCache = [];
let cacheTimestamp = 0;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

// ---------- ROOT ----------
app.get("/", (_req, res) => {
  res.json({ 
    status: "✅ Server running", 
    endpoints: ["POST /search", "GET /search?q=text"],
    shop: SHOP_DOMAIN
  });
});

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// ---------- SEARCH (TEXT & IMAGE) ----------
app.post("/search", upload.single("image"), async (req, res) => {
  const q = req.query.q?.trim() || "";
  const tmpPath = req.file?.path ? path.resolve(req.file.path) : null;

  try {
    // If a text query is provided, proceed with text search
    if (q) {
      const products = await searchShopifyProducts({ query: q, first: 12 });
      return res.json({ products, searchType: "text", query: q });
    }

    // If an image is provided, proceed with image-based search
    if (req.file) {
      console.log("✅ Image uploaded successfully");

      // Step 1: Process and analyze the image
      const imageFeatures = await extractImageFeatures(req.file.path);
      
      // Step 2: Fetch all products from Shopify (with caching)
      let products;
      try {
        products = await getCachedProducts();
      } catch (error) {
        console.error("❌ Error fetching Shopify products:", error);
        return res.status(500).json({ error: "Failed to fetch Shopify products" });
      }

      // Step 3: Compare image with products
      const matchedProducts = await findSimilarProducts(imageFeatures, products);

      console.log(`✅ Image search completed. Found ${matchedProducts.length} matches`);
      return res.json({ 
        products: matchedProducts, 
        searchType: "image",
        imageFeatures 
      });
    }

    return res.status(400).json({ error: "No text or image provided for search" });

  } catch (err) {
    console.error("❌ /search error:", err.message || err);
    return res.status(500).json({ error: "Server error while searching: " + err.message });
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) {
      fs.promises.unlink(tmpPath).catch(() => {});
    }
  }
});

// ---------- TEXT SEARCH ENDPOINT ----------
app.get("/search", async (req, res) => {
  const q = req.query.q?.trim() || "";
  const sort = req.query.sort || "RELEVANCE";

  if (!q) {
    return res.status(400).json({ error: "No search query provided" });
  }

  try {
    const products = await searchShopifyProducts({ query: q, first: 50 });
    
    // Apply sorting
    let sortedProducts = [...products];
    if (sort === "PRICE_ASC") {
      sortedProducts.sort((a, b) => (parseFloat(a.price) || 0) - (parseFloat(b.price) || 0));
    } else if (sort === "PRICE_DESC") {
      sortedProducts.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0));
    } else if (sort === "TITLE_ASC") {
      sortedProducts.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
    } else if (sort === "TITLE_DESC") {
      sortedProducts.sort((a, b) => (b.title || "").localeCompare(a.title || ""));
    }

    return res.json({ 
      products: sortedProducts, 
      searchType: "text", 
      query: q,
      sort 
    });
  } catch (err) {
    console.error("❌ /search GET error:", err.message || err);
    return res.status(500).json({ error: "Server error while searching: " + err.message });
  }
});

// ---------- PRODUCTS CACHE ----------
async function getCachedProducts() {
  const now = Date.now();
  
  // Return cached products if they're still fresh
  if (productsCache.length > 0 && (now - cacheTimestamp) < CACHE_DURATION) {
    console.log("✅ Returning cached products");
    return productsCache;
  }
  
  // Otherwise fetch fresh products
  console.log("🔄 Fetching fresh products from Shopify");
  productsCache = await fetchAllShopifyProducts();
  cacheTimestamp = now;
  
  return productsCache;
}

// Clear cache endpoint (for debugging)
app.post("/clear-cache", (_req, res) => {
  productsCache = [];
  cacheTimestamp = 0;
  res.json({ message: "Cache cleared successfully" });
});

// ---------- IMAGE PROCESSING ----------
async function extractImageFeatures(imagePath) {
  try {
    const metadata = await sharp(imagePath).metadata();
    const { dominantColors } = await extractDominantColors(imagePath);
    
    return {
      dominantColors,
      dimensions: { width: metadata.width, height: metadata.height },
      processedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error("Error processing image:", error);
    throw new Error("Failed to process image");
  }
}

async function extractDominantColors(imagePath) {
  try {
    const { data, info } = await sharp(imagePath)
      .resize(50, 50, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const colors = {};
    let totalPixels = 0;
    
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      const colorKey = `${Math.round(r/32)*32},${Math.round(g/32)*32},${Math.round(b/32)*32}`;
      colors[colorKey] = (colors[colorKey] || 0) + 1;
      totalPixels++;
    }
    
    const dominantColors = Object.entries(colors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([color, count]) => ({ 
        color, 
        percentage: (count / totalPixels) * 100 
      }));
    
    return { dominantColors };
  } catch (error) {
    console.error("Error extracting dominant colors:", error);
    return { dominantColors: [] };
  }
}

// ---------- PRODUCT MATCHING ----------
async function findSimilarProducts(imageFeatures, products) {
  console.log(`Starting image comparison with ${products.length} products...`);
  
  const matchedProducts = products.map(product => {
    let score = 0;
    
    // Basic title matching (fast and reliable)
    score = basicTitleMatching(imageFeatures, product);
    
    return {
      ...product,
      matchScore: Math.round(score)
    };
  });
  
  // Sort by match score and return top 12
  const sortedProducts = matchedProducts
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 12);
  
  console.log(`Found ${sortedProducts.length} matches`);
  return sortedProducts;
}

function basicTitleMatching(imageFeatures, product) {
  let score = 0;
  const title = product.title.toLowerCase();
  
  // Color matching based on uploaded image colors
  const colorNames = [];
  for (const colorData of imageFeatures.dominantColors) {
    const [r, g, b] = colorData.color.split(',').map(Number);
    const colorName = getColorName(r, g, b);
    if (colorName) colorNames.push(colorName);
  }
  
  // Check if any color name appears in the product title
  for (const colorName of colorNames) {
    if (title.includes(colorName)) {
      score += 40;
      break;
    }
  }
  
  // Product type matching
  const typeTerms = ['shirt', 'dress', 'pant', 'jean', 'skirt', 'jacket', 'coat', 
                    'shoe', 'sneaker', 'top', 'bag', 'accessory', 'jewelry'];
  for (const type of typeTerms) {
    if (title.includes(type)) {
      score += 35;
      break;
    }
  }
  
  // Material/pattern matching
  const materialTerms = ['cotton', 'denim', 'leather', 'silk', 'wool', 'linen', 
                        'knit', 'print', 'striped', 'floral', 'plain'];
  for (const material of materialTerms) {
    if (title.includes(material)) {
      score += 25;
      break;
    }
  }
  
  return score;
}

function getColorName(r, g, b) {
  if (r > 200 && g < 100 && b < 100) return 'red';
  if (r < 100 && g < 100 && b > 200) return 'blue';
  if (r < 100 && g > 200 && b < 100) return 'green';
  if (r < 100 && g < 100 && b < 100) return 'black';
  if (r > 200 && g > 200 && b > 200) return 'white';
  if (r > 200 && g > 200 && b < 100) return 'yellow';
  if (r > 200 && g < 100 && b > 200) return 'pink';
  if (r > 150 && g < 100 && b > 150) return 'purple';
  if (r > 200 && g > 100 && b < 100) return 'orange';
  if (r > 150 && g > 100 && b < 100) return 'orange';
  if (r < 100 && g > 150 && b > 150) return 'teal';
  if (r > 150 && g < 150 && b < 150) return 'brown';
  if (r > 180 && g > 180 && b > 180) return 'gray';
  return null;
}

// ---------- SHOPIFY INTEGRATION (OPTIMIZED) ----------
async function searchShopifyProducts({ query, first = 12 }) {
  const storefrontGql = `
    query($query: String!, $first: Int!) {
      products(query: $query, first: $first) {
        edges {
          node {
            id
            title
            handle
            featuredImage {
              url
            }
            variants(first: 1) {
              edges {
                node {
                  price {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
      }
    }
  `;
  
  try {
    const resp = await axios.post(
      `https://${SHOP_DOMAIN}/api/2024-07/graphql.json`,
      { query: storefrontGql, variables: { query, first } },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": ACCESS_TOKEN,
        },
        timeout: 10000
      }
    );
    
    const items = resp?.data?.data?.products?.edges || [];
    return items.map(({ node }) => ({
      id: node.id,
      title: node.title,
      url: `https://${SHOP_DOMAIN}/products/${node.handle}`,
      image: node.featuredImage?.url || "",
      price: node.variants?.edges?.[0]?.node?.price?.amount || "0",
      currency: node.variants?.edges?.[0]?.node?.price?.currencyCode || "USD",
    }));
  } catch (error) {
    console.error("Error fetching Shopify products:", error.response?.data || error.message);
    throw new Error("Failed to fetch products from Shopify");
  }
}

async function fetchAllShopifyProducts() {
  let allProducts = [];
  let afterCursor = null;
  let hasNextPage = true;
  
  const adminGql = `
    query($first: Int!, $after: String) {
      products(first: $first, after: $after, query: "status:active") {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            title
            handle
            featuredImage {
              url
            }
            variants(first: 1) {
              edges {
                node {
                  price
                }
              }
            }
          }
        }
      }
    }
  `;
  
  while (hasNextPage) {
    try {
      const resp = await axios.post(
        `https://${SHOP_DOMAIN}/admin/api/2024-07/graphql.json`,
        { query: adminGql, variables: { first: 50, after: afterCursor } },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          timeout: 15000
        }
      );
      
      const data = resp?.data?.data?.products || {};
      const products = data.edges || [];
      
      allProducts = allProducts.concat(products.map(({ node }) => ({
        id: node.id,
        title: node.title,
        url: `https://${SHOP_DOMAIN}/products/${node.handle}`,
        image: node.featuredImage?.url || "",
        price: node.variants?.edges?.[0]?.node?.price || "0",
        currency: "USD"
      })));
      
      hasNextPage = data.pageInfo?.hasNextPage || false;
      afterCursor = data.pageInfo?.endCursor || null;
      
      console.log(`Fetched ${products.length} products. Total: ${allProducts.length}`);
      
    } catch (error) {
      console.error("Error fetching Shopify products:", error.response?.data || error.message);
      break;
    }
  }
  
  console.log(`Total products available: ${allProducts.length}`);
  return allProducts;
}

// ---------- ERROR HANDLING ----------
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// ---------- START SERVER ----------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  console.log(`🏪 Shopify store: ${SHOP_DOMAIN}`);
  console.log(`⏰ Product cache duration: 30 minutes`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  process.exit(0);
});