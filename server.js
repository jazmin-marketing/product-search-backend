require("dotenv").config();
const express = require("express");
const multer = require("multer");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const { createHash } = require("crypto");
const sharp = require("sharp");
const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');

// Initialize Firebase Admin SDK with service account key
const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

// Access Firebase services
const db = admin.firestore();
const realtimeDb = admin.database();

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// ---------- CONFIG ----------
const SHOP_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const upload = multer({ 
  dest: uploadsDir,
  limits: {
    fileSize: 50 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Load NSFW model for content filtering
let nsfwModel;
(async () => {
  try {
    nsfwModel = await nsfw.load();
    console.log('✅ NSFW model loaded successfully');
  } catch (error) {
    console.error('❌ Failed to load NSFW model:', error);
  }
})();

// ---------- ROOT ----------
app.get("/", (_req, res) => {
  res.send("✅ Server running. Endpoints: POST /search, GET /search?q=text");
});

// ---------- SEARCH (TEXT & IMAGE) ----------
app.post("/search", upload.single("image"), async (req, res) => {
  const q = req.query.q?.trim() || "";
  const tmpPath = req.file?.path ? path.resolve(req.file.path) : null;

  try {
    // If a text query is provided, proceed with text search
    if (q) {
      const products = await searchShopifyProducts({ query: q, first: 12 });
      return res.json({ products });
    }

    // If an image is provided, proceed with image-based search
    if (req.file) {
      console.log("✅ Image uploaded successfully");

      // Check for inappropriate content
      try {
        if (nsfwModel) {
          const image = await fs.promises.readFile(req.file.path);
          const imageTensor = tf.node.decodeImage(image, 3);
          const predictions = await nsfwModel.classify(imageTensor);
          imageTensor.dispose();
          
          const inappropriate = predictions.some(p => 
            ['Porn', 'Hentai', 'Sexy'].includes(p.className) && p.probability > 0.7
          );
          
          if (inappropriate) {
            return res.status(400).json({ error: "Image contains inappropriate content" });
          }
        }
      } catch (error) {
        console.error("❌ Error checking image content:", error);
        // Continue even if content check fails
      }

      // Step 1: Process and analyze the image
      const imageFeatures = await extractImageFeatures(req.file.path);
      
      // Step 2: Fetch all products from Shopify
      let products;
      try {
        products = await fetchAllShopifyProducts();
      } catch (error) {
        console.error("❌ Error fetching Shopify products:", error);
        return res.status(500).json({ error: "Failed to fetch Shopify products" });
      }

      // Step 3: Compare image with products
      const matchedProducts = await findSimilarProducts(imageFeatures, products);

      console.log(`✅ Image search completed. Found ${matchedProducts.length} matches`);
      return res.json({ products: matchedProducts });
    }

    // If neither text nor image is provided, return an error
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
    
    // Apply sorting based on the sort parameter
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

    return res.json({ products: sortedProducts });
  } catch (err) {
    console.error("❌ /search GET error:", err.message || err);
    return res.status(500).json({ error: "Server error while searching: " + err.message });
  }
});

// ---------- IMAGE PROCESSING ----------

// Extract features from an image for comparison
async function extractImageFeatures(imagePath) {
  try {
    // Read image metadata
    const metadata = await sharp(imagePath).metadata();
    
    // Get dominant colors from the entire image
    const { dominantColors } = await extractDominantColors(imagePath);
    
    // Generate a unique filename
    const fileName = `search-${Date.now()}-${Math.random().toString(36).substring(7)}.jpg`;
    const localPath = path.join(__dirname, 'uploads', fileName);
    
    // Create a thumbnail for display
    await sharp(imagePath)
      .resize(300, 300, { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toFile(localPath);
    
    return {
      dominantColors,
      imageUrl: `/uploads/${fileName}`,
      uploadedAt: Date.now(),
      dimensions: { width: metadata.width, height: metadata.height }
    };
  } catch (error) {
    console.error("Error processing image:", error);
    throw new Error("Failed to process image");
  }
}

// Extract dominant colors from an image
async function extractDominantColors(imagePath) {
  try {
    // Resize image for faster processing
    const { data, info } = await sharp(imagePath)
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const colors = {};
    let totalPixels = 0;
    
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Simple color bucketing
      const colorKey = `${Math.round(r/32)*32},${Math.round(g/32)*32},${Math.round(b/32)*32}`;
      colors[colorKey] = (colors[colorKey] || 0) + 1;
      totalPixels++;
    }
    
    // Calculate color histogram
    const dominantColors = Object.entries(colors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5) // Top 5 colors
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

// Find products similar to the image features
async function findSimilarProducts(imageFeatures, products) {
  const matchedProducts = [];
  
  console.log(`Starting image comparison with ${products.length} products...`);
  
  // Process all products
  for (const product of products) {
    let score = 0;
    
    // Check if product has an image
    if (product.image && product.image !== "") {
      try {
        // Download product image for comparison
        const response = await axios.get(product.image, { 
          responseType: 'arraybuffer',
          timeout: 10000
        });
        const productImageBuffer = Buffer.from(response.data);
        
        // Extract features from product image
        const productFeatures = await extractProductImageFeatures(productImageBuffer);
        
        // Compare image features using color comparison
        score = compareColorHistograms(imageFeatures.dominantColors, productFeatures.dominantColors);
        
        // Add bonus for product type matches in title
        const title = product.title.toLowerCase();
        const typeTerms = ['shirt', 'dress', 'pant', 'jean', 'skirt', 'jacket', 'coat', 'shoe', 'sneaker', 'top', 'bottom', 'accessory', 'bag'];
        for (const type of typeTerms) {
          if (title.includes(type)) {
            score += 15;
            break;
          }
        }
      } catch (error) {
        console.error(`Error processing product image for ${product.title}:`, error.message);
        // If we can't process the product image, use a basic title matching approach
        score = basicTitleMatching(imageFeatures, product);
      }
    } else {
      // If product has no image, use basic title matching
      score = basicTitleMatching(imageFeatures, product);
    }
    
    // Always add product to matched products but with their score
    matchedProducts.push({
      ...product,
      matchScore: Math.round(score)
    });
  }
  
  console.log(`Processed ${matchedProducts.length} products`);
  
  // Sort by match score and return top 20
  const sortedProducts = matchedProducts.sort((a, b) => b.matchScore - a.matchScore).slice(0, 20);
  console.log(`Top ${sortedProducts.length} matches with scores:`, sortedProducts.map(p => `${p.title}: ${p.matchScore}`));
  
  return sortedProducts;
}

// Extract features from product image
async function extractProductImageFeatures(imageBuffer) {
  try {
    // Extract dominant colors from product image
    const { dominantColors } = await extractDominantColorsFromBuffer(imageBuffer);
    return { dominantColors };
  } catch (error) {
    console.error("Error extracting features from product image:", error);
    return { dominantColors: [] };
  }
}

// Extract dominant colors from image buffer
async function extractDominantColorsFromBuffer(imageBuffer) {
  try {
    // Resize image for faster processing
    const { data, info } = await sharp(imageBuffer)
      .resize(100, 100, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const colors = {};
    let totalPixels = 0;
    
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      
      // Simple color bucketing
      const colorKey = `${Math.round(r/32)*32},${Math.round(g/32)*32},${Math.round(b/32)*32}`;
      colors[colorKey] = (colors[colorKey] || 0) + 1;
      totalPixels++;
    }
    
    // Calculate color histogram
    const dominantColors = Object.entries(colors)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5) // Top 5 colors
      .map(([color, count]) => ({ 
        color, 
        percentage: (count / totalPixels) * 100 
      }));
    
    return { dominantColors };
  } catch (error) {
    console.error("Error extracting dominant colors from buffer:", error);
    return { dominantColors: [] };
  }
}

// Compare color histograms between two images
function compareColorHistograms(hist1, hist2) {
  let score = 0;
  
  // If either histogram is empty, return 0
  if (hist1.length === 0 || hist2.length === 0) {
    return 0;
  }
  
  // Compare dominant colors
  for (const color1 of hist1) {
    for (const color2 of hist2) {
      if (color1.color === color2.color) {
        // Colors match exactly
        score += Math.min(color1.percentage, color2.percentage) * 3;
      } else {
        // Check if colors are similar
        const [r1, g1, b1] = color1.color.split(',').map(Number);
        const [r2, g2, b2] = color2.color.split(',').map(Number);
        
        const colorDistance = Math.sqrt(
          Math.pow(r1 - r2, 2) + 
          Math.pow(g1 - g2, 2) + 
          Math.pow(b1 - b2, 2)
        );
        
        if (colorDistance < 100) { // Colors are similar
          const similarity = 1 - (colorDistance / 100);
          score += Math.min(color1.percentage, color2.percentage) * similarity;
        }
      }
    }
  }
  
  return score;
}

// Basic title matching as fallback
function basicTitleMatching(imageFeatures, product) {
  let score = 0;
  const title = product.title.toLowerCase();
  
  // Color terms matching based on uploaded image colors
  for (const colorData of imageFeatures.dominantColors) {
    const [r, g, b] = colorData.color.split(',').map(Number);
    
    // Map RGB values to color names
    let colorName = '';
    if (r > 200 && g < 100 && b < 100) colorName = 'red';
    else if (r < 100 && g < 100 && b > 200) colorName = 'blue';
    else if (r < 100 && g > 200 && b < 100) colorName = 'green';
    else if (r < 100 && g < 100 && b < 100) colorName = 'black';
    else if (r > 200 && g > 200 && b > 200) colorName = 'white';
    else if (r > 200 && g > 200 && b < 100) colorName = 'yellow';
    else if (r > 200 && g < 100 && b > 200) colorName = 'pink';
    else if (r > 150 && g < 100 && b > 150) colorName = 'purple';
    else if (r > 200 && g > 100 && b < 100) colorName = 'orange';
    else if (r > 150 && g > 100 && b < 100) colorName = 'orange';
    else if (r > 150 && g > 150 && b < 100) colorName = 'yellow';
    else if (r < 100 && g > 150 && b > 150) colorName = 'teal';
    else if (r > 150 && g < 150 && b < 150) colorName = 'brown';
    
    if (colorName && title.includes(colorName)) {
      score += 20;
      break;
    }
  }
  
  // Product type matching
  const typeTerms = ['shirt', 'dress', 'pant', 'jean', 'skirt', 'jacket', 'coat', 'shoe', 'sneaker', 'boot', 'sandal', 'hat', 'cap', 'glove', 'scarf', 'sock', 'underwear', 'lingerie', 'swimwear', 'activewear', 'jewelry', 'watch', 'bracelet', 'necklace', 'ring', 'earring', 'bag', 'purse', 'backpack', 'wallet', 'belt', 'sunglass', 'glass', 'tie', 'bowtie', 'suit', 'blazer', 'vest', 'hoodie', 'sweater', 'cardigan', 'jumper', 'blouse', 'top', 'tank', 'short', 'legging', 'jogger', 'overall', 'romper', 'jumpsuit'];
  for (const type of typeTerms) {
    if (title.includes(type)) {
      score += 25;
      break;
    }
  }
  
  return score;
}

// ---------- SHOPIFY INTEGRATION ----------

// Function to search Shopify products based on text query
async function searchShopifyProducts({ query, first = 12 }) {
  const storefrontGql = `
    query($query: String!, $first: Int!) {
      products(query: $query, first: $first) {
        edges {
          node {
            id
            title
            description
            handle
            featuredImage {
              url
              altText
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
      { 
        query: storefrontGql, 
        variables: { query: query, first } 
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Storefront-Access-Token": ACCESS_TOKEN,
        },
        timeout: 10000
      }
    );
    
    if (resp.data.errors) {
      console.error("GraphQL errors:", resp.data.errors);
      throw new Error("GraphQL query failed");
    }
    
    const items = resp?.data?.data?.products?.edges || [];
    return items.map(({ node }) => ({
      id: node.id,
      title: node.title,
      description: node.description,
      url: `https://${SHOP_DOMAIN}/products/${node.handle}`,
      image: node.featuredImage?.url || "",
      price: node.variants?.edges?.[0]?.node?.price?.amount || "",
      currency: node.variants?.edges?.[0]?.node?.price?.currencyCode || "",
    }));
  } catch (error) {
    console.error("Error fetching Shopify products:", error.response?.data || error.message);
    throw new Error("Failed to fetch products from Shopify");
  }
}

// Function to fetch all active products from Shopify
async function fetchAllShopifyProducts() {
  let allProducts = [];
  let afterCursor = null;
  let hasNextPage = true;
  
  while (hasNextPage) {
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
              descriptionHtml
              handle
              featuredImage {
                url
                altText
              }
              variants(first: 5) {
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
    
    try {
      const resp = await axios.post(
        `https://${SHOP_DOMAIN}/admin/api/2024-07/graphql.json`,
        { 
          query: adminGql, 
          variables: { first: 50, after: afterCursor } 
        },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": ADMIN_TOKEN,
          },
          timeout: 15000
        }
      );
      
      if (resp.data.errors) {
        console.error("GraphQL errors:", resp.data.errors);
        throw new Error("GraphQL query failed");
      }
      
      const data = resp?.data?.data?.products || {};
      const products = data.edges || [];
      
      // Add products to our collection
      allProducts = allProducts.concat(products.map(({ node }) => ({
        id: node.id,
        title: node.title,
        description: node.descriptionHtml,
        url: `https://${SHOP_DOMAIN}/products/${node.handle}`,
        image: node.featuredImage?.url || "",
        price: node.variants?.edges?.[0]?.node?.price || "",
        currency: "USD"
      })));
      
      // Check if we need to fetch more products
      hasNextPage = data.pageInfo?.hasNextPage || false;
      afterCursor = data.pageInfo?.endCursor || null;
      
      console.log(`Fetched ${products.length} products. Total so far: ${allProducts.length}`);
      
      // Add a small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
      
    } catch (error) {
      console.error("Error fetching Shopify products:", error.response?.data || error.message);
      throw new Error("Failed to fetch products from Shopify");
    }
  }
  
  console.log(`Total products fetched: ${allProducts.length}`);
  return allProducts;
}

// ---------- START ----------
// Serve uploaded images statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`Using Shopify domain: ${SHOP_DOMAIN}`);
});