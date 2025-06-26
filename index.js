// =======================
// 📦 Import Dependencies
// =======================
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// ============================
// 📁 Path Configuration (ESM)
// ============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================
// 🚀 App Setup & Constants
// =========================
const app = express();
const PORT = 3000;
const JWT_SECRET = "super-secret-key";
const MONGO_URI = "mongodb+srv://123:123@cluster0.muiyvkn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// ====================
// 🧩 Middleware Stack
// ====================
app.use(cors({ origin: "http://localhost:5173", credentials: false }));
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ==============================
// 🖼️ Multer File Upload Config
// ==============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({ storage });

// ===========================
// 🔗 MongoDB Initialization
// ===========================
mongoose
  .connect(MONGO_URI, { dbName: "authDB" })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// ======================
// 🧬 Schema Definitions
// ======================
const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  email: { type: String, unique: true },
  password: String,
  role: { type: String, default: "user" },
  profilePicture: { type: String, default: "" },
  status: {
    type: String,
    enum: ["Active", "Offline", "Pending"],
    default: "Offline",
  },
});
const User = mongoose.model("User", userSchema);

const postSchema = new mongoose.Schema({
  title: String,
  content: String,
  image: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});
const Post = mongoose.model("Post", postSchema);

// =======================
// 🔐 JWT Middleware
// =======================
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token missing" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(403).json({ message: "Token invalid or expired" });
  }
};

const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden: Admins only" });
  }
  next();
};

// ========================
// 📮 Post Creation (Admin)
// ========================
app.post(
  "/api/posts",
  authenticate,
  requireAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const { title, content } = req.body;
      const imagePath = req.file ? `/uploads/${req.file.filename}` : "";

      const newPost = new Post({
        title,
        content,
        image: imagePath,
        createdBy: req.user.id,
      });

      await newPost.save();
      res.status(201).json({ message: "Post created", post: newPost });
    } catch (err) {
      res.status(500).json({ message: "Post creation error", error: err.message });
    }
  }
);

// ==============================
// 🧹 Remove Post Image (Admin)
// ==============================
app.delete("/api/posts/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.image) {
      const filePath = path.join(__dirname, post.image);
      fs.unlink(filePath, (err) => {
        if (err) console.warn("⚠️ Could not delete image file:", err.message);
        else console.log("🗑️ Image file removed:", filePath);
      });
    }

    post.image = "";
    await post.save();

    res.json({ message: "✅ Image removed successfully", post });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove image", error: err.message });
  }
});

// ========================
// 📰 Public Post Endpoints
// ========================
app.get("/api/posts", async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch posts", error: err.message });
  }
});

app.get("/api/posts/:id", async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (err) {
    res.status(500).json({ message: "Error fetching post", error: err.message });
  }
});

// ==========================
// 👤 User Registration
// ==========================
app.post("/api/register", upload.single("profilePicture"), async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: "Email already exists" });

    const newUser = new User({
      firstName,
      lastName,
      email,
      password,
      profilePicture: req.file ? `/uploads/${req.file.filename}` : "",
      status: "Offline",
    });

    await newUser.save();
    res.status(201).json({ message: "User registered" });
  } catch (err) {
    res.status(500).json({ message: "Registration error", error: err.message });
  }
});

// ==========================
// 🛠️ Admin User Management
// ==========================
app.get("/api/users", authenticate, requireAdmin, async (req, res) => {
  try {
    const users = await User.find().select("-password");

    const enrichedUsers = users.map(user => ({
      _id: user._id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      role: user.role,
      profilePicture: user.profilePicture,
      status: user.status || "Offline",
    }));

    res.json(enrichedUsers);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users", error: err.message });
  }
});

app.put("/api/users/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const updates = { ...req.body };
    if (!updates.password || updates.password.trim() === "") delete updates.password;

    const updatedUser = await User.findByIdAndUpdate(req.params.id, updates, { new: true }).select("-password");
    if (!updatedUser) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User updated", user: updatedUser });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

app.delete("/api/users/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User deleted", userId: req.params.id });
  } catch (err) {
    res.status(500).json({ message: "Delete failed", error: err.message });
  }
});

// ======================
// 🟢 Start Server
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
