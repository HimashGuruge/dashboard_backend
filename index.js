import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

// ESM __dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const PORT = 3000;
const JWT_SECRET = "super-secret-key";
const MONGO_URI =
  "mongodb+srv://123:123@cluster0.muiyvkn.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";

const io = new SocketIOServer(server, {
    cors: {
      origin: "http://localhost:5173",
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: true, // 💡 NEW: Added this for cookie/auth header support
    }
});

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Middleware
app.use(cors({ origin: "http://localhost:5173", credentials: true })); // 💡 NEW: Added credentials: true
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

// Multer setup
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({ storage });

// MongoDB connection
mongoose
  .connect(MONGO_URI, { dbName: "authDB" })
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB error:", err));

// Schemas
const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: "user" },
  profilePicture: { type: String, default: "" },
  coverPhoto: { type: String, default: "" },
  status: { type: String, enum: ["Active", "Offline", "Pending"], default: "Offline" },
});
const User = mongoose.model("User", userSchema);

const requestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true, trim: true },
  message: { type: String, required: true, trim: true },
  submittedAt: { type: Date, default: Date.now },
  read: { type: Boolean, default: false },
});
const Request = mongoose.model("Request", requestSchema);

const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  image: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  likes: { type: Number, default: 0 },
  likedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
});
const Post = mongoose.model("Post", postSchema);

const commentSchema = new mongoose.Schema({
  postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  content: { type: String, required: true, trim: true },
  createdAt: { type: Date, default: Date.now },
});
const Comment = mongoose.model("Comment", commentSchema);


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

// Optional JWT decode middleware - does NOT block if token missing or invalid
const authenticateOptional = (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded; // Attach user info if token valid
    } catch {
      // Invalid token - ignore and continue
    }
  }
  next();
};

// Admin role middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ message: "Admins only" });
  next();
};

// ========== AUTH ROUTES ==========

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
    console.error("Registration error:", err);
    res.status(500).json({ message: "Registration error", error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }
    const user = await User.findOne({ email, password });
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
        coverPhoto: user.coverPhoto,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Login error", error: err.message });
  }
});

app.post("/api/logout", authenticate, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user.id, { status: "Offline" });
    io.emit('userLoggedOut', { userId: req.user.id });
    res.json({ message: "Logged out" });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ message: "Logout error", error: err.message });
  }
});

app.get("/api/check-email", async (req, res) => {
    try {
      const email = req.query.email;
      if (!email) {
        return res.status(400).json({ message: "Email query parameter is required." });
      }
      const user = await User.findOne({ email });
      res.json({ exists: !!user });
    } catch (error) {
      console.error("Error checking email:", error);
      res.status(500).json({ message: "Server error during email check." });
    }
});

// ========== PROFILE ROUTES ==========

app.get("/api/profile", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ user });
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ message: "Fetch failed", error: err.message });
  }
});

app.put("/api/profile", authenticate, upload.fields([{ name: 'profilePicture', maxCount: 1 }, { name: 'coverPhoto', maxCount: 1 }]), async (req, res) => {
    try {
      const updates = {
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        email: req.body.email,
      };
  
      if (req.body.password && req.body.password.trim()) {
          updates.password = req.body.password;
      }

      if (req.files && req.files['profilePicture'] && req.files['profilePicture'][0]) {
        updates.profilePicture = `/uploads/${req.files['profilePicture'][0].filename}`;
      } else if (req.body.removeProfilePicture === 'true') {
          const user = await User.findById(req.user.id);
          if (user && user.profilePicture) {
              const oldImagePath = path.join(__dirname, user.profilePicture);
              await fs.promises.unlink(oldImagePath).catch(err => console.error("Failed to delete old profile picture:", err));
          }
          updates.profilePicture = "";
      }
  
      if (req.files && req.files['coverPhoto'] && req.files['coverPhoto'][0]) {
        updates.coverPhoto = `/uploads/${req.files['coverPhoto'][0].filename}`;
      } else if (req.body.removeCoverPhoto === 'true') {
          const user = await User.findById(req.user.id);
          if (user && user.coverPhoto) {
              const oldImagePath = path.join(__dirname, user.coverPhoto);
              await fs.promises.unlink(oldImagePath).catch(err => console.error("Failed to delete old cover photo:", err));
          }
          updates.coverPhoto = "";
      }
  
      const updatedUser = await User.findByIdAndUpdate(req.user.id, updates, {
        new: true,
        runValidators: true,
      }).select("-password");
  
      if (!updatedUser) return res.status(404).json({ message: "User not found" });
  
      // Re-sign token with updated user data including coverPhoto
      const token = jwt.sign(
        {
          id: updatedUser._id,
          email: updatedUser.email,
          role: updatedUser.role,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          profilePicture: updatedUser.profilePicture,
          coverPhoto: updatedUser.coverPhoto,
        },
        JWT_SECRET,
        { expiresIn: "1h" }
      );
      
      io.emit('profileUpdated', updatedUser); 

      res.json({ message: "Profile updated", user: updatedUser, token });
    } catch (err) {
      console.error("Error updating profile:", err);
      res.status(500).json({ message: "Update failed", error: err.message });
    }
});


// ========== POST ROUTES ==========

app.get("/api/posts", authenticateOptional, async (req, res) => {
  try {
    const posts = await Post.find().populate('createdBy', 'firstName lastName profilePicture').sort({ createdAt: -1 }).lean();

    const userId = req.user?.id;

    if (userId) {
      posts.forEach((post) => {
        post.likedByCurrentUser = post.likedBy.some(
          (id) => id.toString() === userId
        );
      });
    } else {
      posts.forEach((post) => {
        post.likedByCurrentUser = false;
      });
    }

    res.json(posts);
  } catch (err) {
    console.error("Error fetching posts:", err);
    res.status(500).json({ message: "Failed to fetch posts", error: err.message });
  }
});

app.get("/api/posts/:id", async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate('createdBy', 'firstName lastName profilePicture');
    if (!post) return res.status(404).json({ message: "Post not found" });
    res.json(post);
  } catch (err) {
    console.error("Error fetching single post:", err);
    res.status(500).json({ message: "Error fetching post", error: err.message });
  }
});

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
    const populatedPost = await newPost.populate('createdBy', 'firstName lastName profilePicture');
    io.emit('newPost', populatedPost);
    res.status(201).json({ message: "Post created", post: populatedPost });
  } catch (err) {
    console.error("Post creation error:", err);
    res.status(500).json({ message: "Post creation error", error: err.message });
  }
});

app.put("/api/posts/:id", authenticate, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { title, content } = req.body;
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (req.file) {
      if (post.image) {
        const oldImagePath = path.join(__dirname, post.image);
        await fs.promises.unlink(oldImagePath).catch(err => console.error("Failed to delete old image:", err));
      }
      post.image = `/uploads/${req.file.filename}`;
    } else if (req.body.removeImage === 'true') {
        if (post.image) {
          const oldImagePath = path.join(__dirname, post.image);
          await fs.promises.unlink(oldImagePath).catch(err => console.error("Failed to delete old image:", err));
        }
        post.image = "";
    }

    post.title = title || post.title;
    post.content = content || post.content;

    await post.save();
    const populatedPost = await post.populate('createdBy', 'firstName lastName profilePicture');
    io.emit('postUpdated', populatedPost);
    res.json({ message: "Post updated", post: populatedPost });
  } catch (err) {
    console.error("Update failed:", err);
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

app.delete("/api/posts/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ message: "Post not found" });

    // Delete image file from disk if exists
    if (post.image) {
      const imagePath = path.join(uploadsDir, path.basename(post.image));
      await fs.promises.unlink(imagePath).catch(err => console.error("Failed to delete post image:", err));
    }

    // Delete all comments associated with the post
    await Comment.deleteMany({ postId: req.params.id });

    await Post.findByIdAndDelete(req.params.id);
    io.emit('postDeleted', { postId: req.params.id });
    io.emit('commentsDeletedForPost', { postId: req.params.id });
    res.json({ message: "Post deleted successfully" });
  } catch (err) {
    console.error("Error deleting post:", err);
    res.status(500).json({ message: "Failed to delete post.", error: err.message });
  }
});


app.post("/api/posts/:id/like", authenticate, async (req, res) => {
  try {
    const postId = req.params.id;
    const userId = req.user.id;

    const post = await Post.findById(postId);
    if (!post) return res.status(404).json({ message: "Post not found" });

    const alreadyLiked = post.likedBy.some(id => id.toString() === userId);

    if (alreadyLiked) {
      post.likes -= 1;
      post.likedBy = post.likedBy.filter(id => id.toString() !== userId);
    } else {
      post.likes += 1;
      post.likedBy.push(userId);
    }

    await post.save();

    // 💡 NEW: We fetch the post again to populate the createdBy field for the socket event
    const updatedPost = await Post.findById(post._id).populate('createdBy', 'firstName lastName profilePicture').lean();
    
    // ✅ NEW: Add likedByCurrentUser flag for the frontend to update the icon
    updatedPost.likedByCurrentUser = !alreadyLiked;

    io.emit('postUpdated', updatedPost);

    res.json({
      likes: post.likes,
      likedByCurrentUser: !alreadyLiked
    });
  } catch (err) {
    console.error("Like action failed:", err);
    res.status(500).json({ message: "Like action failed", error: err.message });
  }
});

app.get("/api/posts/:id/likes", authenticateOptional, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate('likedBy', 'firstName lastName profilePicture');
    if (!post) return res.status(404).json({ message: "Post not found" });

    const likedByCurrentUser = req.user ?
      post.likedBy.some(user => user._id.toString() === req.user.id) :
      false;

    res.json({
      count: post.likes,
      likedByCurrentUser,
      users: post.likedBy
    });
  } catch (err) {
    console.error("Failed to get likes:", err);
    res.status(500).json({ message: "Failed to get likes", error: err.message });
  }
});

// ========== COMMENT ROUTES ==========

app.post("/api/posts/:postId/comments", authenticate, async (req, res) => {
  try {
    const { postId } = req.params;
    const { content } = req.body;
    const userId = req.user.id;

    const postExists = await Post.findById(postId);
    if (!postExists) return res.status(404).json({ message: "Post not found." });
    if (!content || content.trim() === "") return res.status(400).json({ message: "Comment content cannot be empty." });

    const newComment = new Comment({
      postId,
      userId,
      content,
    });

    await newComment.save();
    // Populate user details for real-time update
    const populatedComment = await newComment.populate('userId', 'firstName lastName profilePicture');

    io.emit('newComment', populatedComment);
    res.status(201).json({ message: "Comment added successfully", comment: populatedComment });
  } catch (err) {
    console.error("Error adding comment:", err);
    res.status(500).json({ message: "Failed to add comment.", error: err.message });
  }
});

app.get("/api/posts/:postId/comments", authenticateOptional, async (req, res) => {
  try {
    const { postId } = req.params;
    const comments = await Comment.find({ postId })
      .populate('userId', 'firstName lastName profilePicture')
      .sort({ createdAt: 1 });

    res.json(comments);
  } catch (err) {
    console.error("Error fetching comments:", err);
    res.status(500).json({ message: "Failed to fetch comments.", error: err.message });
  }
});

app.delete("/api/comments/:commentId", authenticate, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    const commentToDelete = await Comment.findById(commentId);
    if (!commentToDelete) {
      return res.status(404).json({ message: "Comment not found." });
    }

    const post = await Post.findById(commentToDelete.postId);

    // Allow deletion by comment owner, post creator, or admin
    const isOwner = commentToDelete.userId.toString() === userId;
    const isPostCreator = post && post.createdBy.toString() === userId;
    const isAdmin = userRole === 'admin';

    if (!isOwner && !isPostCreator && !isAdmin) {
      return res.status(403).json({ message: "Unauthorized to delete this comment." });
    }

    await Comment.findByIdAndDelete(commentId);
    io.emit('commentDeleted', { commentId, postId: commentToDelete.postId });
    res.json({ message: "Comment deleted successfully." });
  } catch (err) {
    console.error("Error deleting comment:", err);
    res.status(500).json({ message: "Failed to delete comment.", error: err.message });
  }
});


// ========== User Management Endpoints (Admin) ==========

app.get("/api/users", authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: "Access Denied: Admins only." });
    }
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).json({ message: "Failed to fetch users.", error: err.message });
  }
});

app.put("/api/users/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const { firstName, lastName, email, role, password } = req.body;
    const updates = { firstName, lastName, email, role };

    if (password) {
      updates.password = password;
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    ).select('-password');

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json({ message: "User updated successfully", user: updatedUser });
  } catch (err) {
    console.error("Error updating user:", err);
    res.status(500).json({ message: "Failed to update user.", error: err.message });
  }
});

app.delete("/api/users/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) {
      return res.status(404).json({ message: "User not found." });
    }
    res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Error deleting user:", err);
    res.status(500).json({ message: "Failed to delete user.", error: err.message });
  }
});


// ========== Request/Mail Endpoints ==========
app.get("/api/requests", authenticate, requireAdmin, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const totalRequests = await Request.countDocuments();
      const totalPages = Math.ceil(totalRequests / limit);

      const requests = await Request.find()
          .populate('userId', 'firstName lastName email')
          .sort({ submittedAt: -1 })
          .skip(skip)
          .limit(limit);

      res.json({ mails: requests, totalPages, currentPage: page });
    } catch (err) {
      console.error("Error fetching requests:", err);
      res.status(500).json({ message: "Failed to fetch requests.", error: err.message });
    }
});

app.get("/api/requests/unread-count", authenticate, requireAdmin, async (req, res) => {
    try {
      const unreadCount = await Request.countDocuments({ read: false });
      res.json({ unreadCount });
    } catch (err) {
      console.error("Error fetching unread count:", err);
      res.status(500).json({ message: "Failed to fetch unread count.", error: err.message });
    }
});

app.put("/api/requests/:id/mark-read", authenticate, requireAdmin, async (req, res) => {
    try {
      const request = await Request.findByIdAndUpdate(req.params.id, { read: true }, { new: true });
      if (!request) {
        return res.status(404).json({ message: "Request not found." });
      }
      io.emit('mailRead', { requestId: request._id });
      res.json({ message: "Request marked as read", request });
    } catch (err) {
      console.error("Error marking request as read:", err);
      res.status(500).json({ message: "Failed to mark request as read.", error: err.message });
    }
});

app.delete("/api/requests/:id", authenticate, requireAdmin, async (req, res) => {
    try {
      const deletedRequest = await Request.findByIdAndDelete(req.params.id);
      if (!deletedRequest) {
        return res.status(404).json({ message: "Request not found." });
      }
      res.json({ message: "Request deleted successfully" });
    } catch (err) {
      console.error("Error deleting request:", err);
      res.status(500).json({ message: "Failed to delete request.", error: err.message });
    }
});

app.post("/api/request", authenticate, async (req, res) => {
    try {
      const { title, message } = req.body;
      const userId = req.user.id;

      const newRequest = new Request({
          userId,
          title,
          message,
      });

      await newRequest.save();
      const populatedRequest = await newRequest.populate('userId', 'email');
      io.emit('newMailRequest', populatedRequest);

      res.status(201).json({ message: "Request submitted successfully!", request: newRequest });
    } catch (err) {
      console.error("Error submitting request:", err);
      res.status(500).json({ message: "Failed to submit request.", error: err.message });
    }
});


// Socket.IO connection event
io.on('connection', (socket) => {
    console.log(`User connected with socket ID: ${socket.id} 🤝`);

    // 💡 NEW: Handle authentication and add user to a room if needed
    // This is a more advanced step for real-time user status, but not strictly needed for this fix.
    // socket.on('authenticate', (token) => { ... });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id} 🚪`);
    });
});


// Start the HTTP server, not the Express app
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`⚡️ Socket.IO is ready for real-time connections!`);
});