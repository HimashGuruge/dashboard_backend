import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

// ESM __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const JWT_SECRET = "super-secret-key"; // Use env vars in production
const MONGO_URI = "mongodb+srv://123:123@cluster0.muiyvkn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Middleware
app.use(cors({ origin: "http://localhost:5173", credentials: false }));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({ storage });

// MongoDB connection & schemas
mongoose
  .connect(MONGO_URI, { dbName: "authDB" })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // Hash in production
  role: { type: String, default: "user" },
  profilePicture: { type: String, default: "" },
  status: { type: String, enum: ["Active", "Offline", "Pending"], default: "Offline" },
});
const User = mongoose.model("User", userSchema);

const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  image: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
});
const Post = mongoose.model("Post", postSchema);

// JWT Authentication middleware
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token missing" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ message: "Token invalid or expired" });
  }
};

// Admin check middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ message: "Admins only" });
  next();
};

// Register user
app.post("/api/register", upload.single("profilePicture"), async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    const exists = await User.findOne({ email });
    if (exists) return res.status(400).json({ message: "Email already exists" });

    const newUser = new User({
      firstName,
      lastName,
      email,
      password, // ⚠️ Hash before save in production
      profilePicture: req.file ? `/uploads/${req.file.filename}` : "",
      status: "Offline",
    });

    await newUser.save();
    res.status(201).json({ message: "User registered" });
  } catch (err) {
    res.status(500).json({ message: "Registration error", error: err.message });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email, password }); // ⚠️ bcrypt recommended
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    await User.findByIdAndUpdate(user._id, { status: "Active" });

    const token = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token });
  } catch (err) {
    res.status(500).json({ message: "Login error", error: err.message });
  }
});

// Logout
app.post("/api/logout", authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { status: "Offline" });
    res.json({ message: "Logged out" });
  } catch (err) {
    res.status(500).json({ message: "Logout error", error: err.message });
  }
});

// Get user profile
app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ message: "Fetch failed", error: err.message });
  }
});

// Update user profile
app.put("/api/profile", authenticate, upload.single("profilePicture"), async (req, res) => {
  try {
    const updates = {
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
    };

    if (req.file) {
      updates.profilePicture = `/uploads/${req.file.filename}`;
    }

    const updatedUser = await User.findByIdAndUpdate(req.user.id, updates, {
      new: true,
      runValidators: true,
    }).select("-password");

    if (!updatedUser) return res.status(404).json({ message: "User not found" });

    res.json({ message: "Profile updated", user: updatedUser });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

// Get all posts
app.get("/api/posts", async (req, res) => {
  try {
    const posts = await Post.find().sort({ createdAt: -1 });
    res.json(posts);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch posts", error: err.message });
  }
});

// Get single post
app.get("/api/posts/:id", async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (err) {
    res.status(500).json({ message: "Error fetching post", error: err.message });
  }
});

// Create post (admin only)
app.post("/api/posts", authenticate, requireAdmin, upload.single("image"), async (req, res) => {
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
});

// Update post (admin only)
app.put("/api/posts/:id", authenticate, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { title, content } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (req.file) {
      // Delete old image if exists
      if (post.image) {
        const oldImagePath = path.join(__dirname, post.image);
        fs.unlink(oldImagePath, (err) => {
          if (err) console.warn("Failed to delete old image:", err.message);
        });
      }
      post.image = `/uploads/${req.file.filename}`;
    }

    post.title = title || post.title;
    post.content = content || post.content;

    await post.save();
    res.json({ message: "Post updated successfully", post });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

// Delete post image (admin only)
app.delete("/api/posts/:id/image", authenticate, requireAdmin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (post.image) {
      const filePath = path.join(__dirname, post.image);
      fs.unlink(filePath, (err) => {
        if (err) console.warn("Could not delete image file:", err.message);
        else console.log("Image file removed:", filePath);
      });
      post.image = "";
      await post.save();
    }

    res.json({ message: "Image removed successfully", post });
  } catch (err) {
    res.status(500).json({ message: "Failed to remove image", error: err.message });
  }
});

// Get all users (admin only)
app.get("/api/users", authenticate, requireAdmin, async (req, res) => {
  try {
    const users = await User.find({}, "firstName lastName email status").exec();
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users", error: err.message });
  }
});

// Update user (admin only)
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

// Delete user (admin only)
app.delete("/api/users/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) return res.status(404).json({ message: "User not found" });

    res.json({ message: "User deleted", userId: req.params.id });
  } catch (err) {
    res.status(500).json({ message: "Delete failed", error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
