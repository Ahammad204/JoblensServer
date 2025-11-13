//Initial index.js setup for server
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const app = express();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

//Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

//port
const port = process.env.PORT || 5000;

//Connect to MongoDB

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const uri = process.env.MONGODB;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
const verifyToken = (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized: No token" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ message: "Forbidden: Invalid token" });
  }
};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    // ======================== All Collections =========================
    const UsersCollection = client.db("UserDB").collection("Users");

    //Upload user to Database
    app.post("/api/register", async (req, res) => {
      try {
        const {
          name,
          email,
          passwordHash,
          education,
          experience,
          careerTrack,
          roles,
          avatarUrl,
          createdAt,
        } = req.body;

        // Check if user already exists
        const existingUser = await UsersCollection.findOne({ email });
        if (existingUser) {
          return res.status(409).json({ message: "User already exists" });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(passwordHash, 10);

        // Create new user
        const newUser = {
          name,
          email,
          password: hashedPassword,
          education,
          experience,
          careerTrack,
          roles: roles || "user",
          avatar: avatarUrl,

          createdAt: createdAt ? new Date(createdAt) : new Date(),
        };

        // Insert into database
        const result = await UsersCollection.insertOne(newUser);

        // Generate JWT
        const token = jwt.sign({ email }, process.env.JWT_SECRET, {
          expiresIn: "7d",
        });

        // Set cookie
        res.cookie("token", token, {
          httpOnly: true,
          secure: true, // required for cross-site cookies
          sameSite: "none", // required for cross-site cookies
          maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        });

        res.status(201).json({
          message: "Registration successful",
          userId: result.insertedId,
        });
      } catch (error) {
        console.error("Registration Error:", error);
        res.status(500).json({
          message: "Registration failed",
          error: error.message,
        });
      }
    });

    //user login
    app.post("/api/login", async (req, res) => {
      try {
        const { email, password } = req.body;

        const user = await UsersCollection.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch)
          return res.status(401).json({ message: "Invalid password" });

        const token = jwt.sign({ email: user.email }, process.env.JWT_SECRET, {
          expiresIn: "7d",
        });

        res.cookie("token", token, {
          httpOnly: true,
          secure: true, //  required for cross-site cookies
          sameSite: "none", //  required for cross-site cookies
          maxAge: 7 * 24 * 60 * 60 * 1000,
        });
        res.status(200).json({ message: "Login successful", user });
      } catch (err) {
        res.status(500).json({ message: "Login failed", error: err.message });
      }
    });

    //Logout user
    app.post("/api/logout", (req, res) => {
      res.clearCookie("token", {
        httpOnly: true,
        secure: true,
        sameSite: "none",
      });

      res.status(200).json({ message: "Logout successful" });
    });

    //Check if user is logged in
    app.get("/api/me", async (req, res) => {
      try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ message: "Unauthorized" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await UsersCollection.findOne({ email: decoded.email });

        if (!user) return res.status(404).json({ message: "User not found" });

        res.status(200).json({ user });
      } catch (err) {
        res.status(401).json({ message: "Unauthorized", error: err.message });
      }
    });
    // Update user profile
app.patch("/users/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Ensure the logged-in user can only update their own profile
    const userInDb = await UsersCollection.findOne({ _id: new ObjectId(id) });
    if (!userInDb) return res.status(404).json({ message: "User not found" });
    if (userInDb.email !== req.user.email) {
      return res.status(403).json({ message: "Forbidden: Cannot update other user's profile" });
    }

    const updateFields = { ...req.body };

    // Prevent email change
    if (updateFields.email) delete updateFields.email;

    // Convert skills and preferredJobType to arrays if they are strings
    if (updateFields.skills && !Array.isArray(updateFields.skills)) {
      updateFields.skills = updateFields.skills.split(",").map(s => s.trim()).filter(Boolean);
    }
    if (updateFields.preferredJobType && !Array.isArray(updateFields.preferredJobType)) {
      updateFields.preferredJobType = updateFields.preferredJobType.split(",").map(s => s.trim()).filter(Boolean);
    }

    // Update user
    const result = await UsersCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    res.status(200).json(result.value);
  } catch (err) {
    console.error("Profile Update Error:", err);
    res.status(500).json({ message: "Failed to update profile", error: err.message });
  }
});


  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

//For knowing that server is working or not
app.get("/", (req, res) => {
  res.send("Server is Running....");
});

//For knowing which port we are use
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
