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
    const JobsCollection = client.db("JobsDB").collection("Jobs");
    const LearningResourcesCollection = client.db("LearningDB").collection("LearningResources");

    // =============================== User Endpoints ==============================
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
        const userInDb = await UsersCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!userInDb)
          return res.status(404).json({ message: "User not found" });
        if (userInDb.email !== req.user.email) {
          return res
            .status(403)
            .json({ message: "Forbidden: Cannot update other user's profile" });
        }

        const updateFields = { ...req.body };

        // Prevent email change
        if (updateFields.email) delete updateFields.email;

        // Convert skills and preferredJobType to arrays if they are strings
        if (updateFields.skills && !Array.isArray(updateFields.skills)) {
          updateFields.skills = updateFields.skills
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (
          updateFields.preferredJobType &&
          !Array.isArray(updateFields.preferredJobType)
        ) {
          updateFields.preferredJobType = updateFields.preferredJobType
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
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
        res
          .status(500)
          .json({ message: "Failed to update profile", error: err.message });
      }
    });

    // ============================ Job Endpoints =======================================
    // ===================== Seed Jobs =====================
    app.post("/api/jobs/seed", async (req, res) => {
      try {
        const jobs = [
          {
            title: "Frontend Developer Intern",
            company: "Nexgenix",
            location: "Remote",
            skills: ["React", "JavaScript", "Tailwind CSS"],
            experienceLevel: "Beginner",
            jobType: "Internship",
          },
          {
            title: "Junior Backend Developer",
            company: "CodeWave",
            location: "Dhaka",
            skills: ["Node.js", "Express", "MongoDB"],
            experienceLevel: "Entry-level",
            jobType: "Full-time",
          },
          {
            title: "UI/UX Designer",
            company: "Designify Studio",
            location: "Chattogram",
            skills: ["Figma", "Adobe XD", "Wireframing"],
            experienceLevel: "Beginner",
            jobType: "Part-time",
          },
          {
            title: "WordPress Developer",
            company: "WebMate",
            location: "Remote",
            skills: ["WordPress", "PHP", "HTML", "CSS"],
            experienceLevel: "Entry-level",
            jobType: "Freelance",
          },
          {
            title: "Data Entry Operator",
            company: "TechData BD",
            location: "Dhaka",
            skills: ["Excel", "Attention to Detail"],
            experienceLevel: "Beginner",
            jobType: "Part-time",
          },
          {
            title: "Junior Mobile App Developer",
            company: "AppLab",
            location: "Remote",
            skills: ["React Native", "JavaScript", "API Integration"],
            experienceLevel: "Beginner",
            jobType: "Internship",
          },
          {
            title: "Social Media Marketing Intern",
            company: "DigitalSphere",
            location: "Chattogram",
            skills: ["Canva", "Content Writing", "Meta Ads"],
            experienceLevel: "Beginner",
            jobType: "Internship",
          },
          {
            title: "IT Support Assistant",
            company: "SoftCare",
            location: "Sylhet",
            skills: ["Networking", "Troubleshooting", "Customer Support"],
            experienceLevel: "Entry-level",
            jobType: "Full-time",
          },
          {
            title: "Graphic Designer",
            company: "PixelCraft",
            location: "Remote",
            skills: ["Illustrator", "Photoshop", "Brand Design"],
            experienceLevel: "Beginner",
            jobType: "Freelance",
          },
          {
            title: "Junior QA Tester",
            company: "Testify BD",
            location: "Dhaka",
            skills: ["Testing", "Documentation", "Teamwork"],
            experienceLevel: "Beginner",
            jobType: "Internship",
          },
          {
            title: "Content Writer",
            company: "Penly Studio",
            location: "Remote",
            skills: ["SEO Writing", "Research", "English Proficiency"],
            experienceLevel: "Entry-level",
            jobType: "Freelance",
          },
          {
            title: "Junior Web Developer",
            company: "BrightWeb",
            location: "Dhaka",
            skills: ["HTML", "CSS", "JavaScript"],
            experienceLevel: "Beginner",
            jobType: "Full-time",
          },
          {
            title: "Video Editor Intern",
            company: "Vibe Media",
            location: "Remote",
            skills: ["Premiere Pro", "After Effects", "Storytelling"],
            experienceLevel: "Beginner",
            jobType: "Internship",
          },
          {
            title: "Database Assistant",
            company: "DataSync BD",
            location: "Sylhet",
            skills: ["SQL", "Excel", "Data Cleaning"],
            experienceLevel: "Entry-level",
            jobType: "Part-time",
          },
          {
            title: "Junior Cloud Engineer",
            company: "CloudBase",
            location: "Dhaka",
            skills: ["AWS", "Linux", "CI/CD"],
            experienceLevel: "Entry-level",
            jobType: "Full-time",
          },
        ];

        await JobsCollection.insertMany(jobs);
        res.status(201).json({ message: "Jobs seeded successfully" });
      } catch (error) {
        console.error("Job Seeding Error:", error);
        res
          .status(500)
          .json({ message: "Failed to seed jobs", error: error.message });
      }
    });
    // ===================== Get All Jobs =====================
    app.get("/api/jobs", async (req, res) => {
      try {
        const jobs = await JobsCollection.find().toArray();
        res.status(200).json(jobs);
      } catch (error) {
        res
          .status(500)
          .json({ message: "Failed to fetch jobs", error: error.message });
      }
    });
    app.get("/api/jobs/:id", async (req, res) => {
      try {
        const job = await JobsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!job) return res.status(404).json({ message: "Job not found" });
        res.status(200).json(job);
      } catch (error) {
        res
          .status(500)
          .json({ message: "Failed to fetch job", error: error.message });
      }
    });
    app.post("/api/jobs", verifyToken, async (req, res) => {
      try {
        const job = req.body;
        await JobsCollection.insertOne(job);
        res.status(201).json({ message: "Job added successfully" });
      } catch (error) {
        res
          .status(500)
          .json({ message: "Failed to add job", error: error.message });
      }
    });

    // ========================== Resources Endpoints ==========================
    app.post("/api/learning/seed", async (req, res) => {
  try {
    const resources = [
      {
        title: "HTML Full Course for Beginners",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=pQN-pnXPaVg",
        relatedSkills: ["HTML", "Web Development"],
        cost: "Free",
      },
      {
        title: "JavaScript Basics",
        platform: "Coursera",
        url: "https://www.coursera.org/learn/javascript-basics",
        relatedSkills: ["JavaScript"],
        cost: "Free",
      },
      {
        title: "Responsive Web Design",
        platform: "freeCodeCamp",
        url: "https://www.freecodecamp.org/learn/responsive-web-design/",
        relatedSkills: ["HTML", "CSS", "Design"],
        cost: "Free",
      },
      {
        title: "Advanced CSS and Sass",
        platform: "Udemy",
        url: "https://www.udemy.com/course/advanced-css-and-sass/",
        relatedSkills: ["CSS", "Sass"],
        cost: "Paid",
      },
      {
        title: "React JS Crash Course",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=w7ejDZ8SWv8",
        relatedSkills: ["React", "Frontend"],
        cost: "Free",
      },
      {
        title: "MongoDB for Beginners",
        platform: "Udemy",
        url: "https://www.udemy.com/course/mongodb-the-complete-developers-guide/",
        relatedSkills: ["MongoDB", "Database"],
        cost: "Paid",
      },
      {
        title: "Node.js and Express.js Fundamentals",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=Oe421EPjeBE",
        relatedSkills: ["Node.js", "Express"],
        cost: "Free",
      },
      {
        title: "Intro to Communication Skills",
        platform: "Coursera",
        url: "https://www.coursera.org/learn/wharton-communication-skills",
        relatedSkills: ["Communication", "Soft Skills"],
        cost: "Free",
      },
      {
        title: "Learn Excel for Beginners",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=Vl0H-qTclOg",
        relatedSkills: ["Excel", "Data Management"],
        cost: "Free",
      },
      {
        title: "Python for Everybody",
        platform: "Coursera",
        url: "https://www.coursera.org/specializations/python",
        relatedSkills: ["Python", "Programming"],
        cost: "Free",
      },
      {
        title: "Intro to Data Analysis with Excel",
        platform: "Udemy",
        url: "https://www.udemy.com/course/microsoft-excel-data-analysis/",
        relatedSkills: ["Excel", "Data Analysis"],
        cost: "Paid",
      },
      {
        title: "Canva Graphic Design Masterclass",
        platform: "Udemy",
        url: "https://www.udemy.com/course/canva-masterclass/",
        relatedSkills: ["Design", "Canva"],
        cost: "Paid",
      },
      {
        title: "Learn Git & GitHub",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=RGOj5yH7evk",
        relatedSkills: ["Git", "Version Control"],
        cost: "Free",
      },
      {
        title: "Effective Presentation Skills",
        platform: "Coursera",
        url: "https://www.coursera.org/learn/presentation-skills",
        relatedSkills: ["Communication", "Leadership"],
        cost: "Free",
      },
      {
        title: "Project Management Basics",
        platform: "Coursera",
        url: "https://www.coursera.org/learn/project-management-principles",
        relatedSkills: ["Project Management", "Organization"],
        cost: "Free",
      },
      {
        title: "Digital Marketing Fundamentals",
        platform: "Google Digital Garage",
        url: "https://learndigital.withgoogle.com/digitalgarage/course/digital-marketing",
        relatedSkills: ["Marketing", "SEO", "Content"],
        cost: "Free",
      },
      {
        title: "UI/UX Design for Beginners",
        platform: "YouTube",
        url: "https://www.youtube.com/watch?v=c9Wg6Cb_YlU",
        relatedSkills: ["UI/UX", "Design"],
        cost: "Free",
      },
      {
        title: "Advanced Excel Formulas & Functions",
        platform: "Udemy",
        url: "https://www.udemy.com/course/advanced-excel-formulas/",
        relatedSkills: ["Excel", "Data Analysis"],
        cost: "Paid",
      },
      {
        title: "Machine Learning Crash Course",
        platform: "Google",
        url: "https://developers.google.com/machine-learning/crash-course",
        relatedSkills: ["AI", "Machine Learning"],
        cost: "Free",
      },
      {
        title: "Personal Productivity",
        platform: "Coursera",
        url: "https://www.coursera.org/learn/work-smarter-not-harder",
        relatedSkills: ["Productivity", "Soft Skills"],
        cost: "Free",
      },
    ];

    await LearningResourcesCollection.insertMany(resources);
    res.status(201).json({ message: "Learning resources seeded successfully" });
  } catch (error) {
    console.error("Learning Seed Error:", error);
    res
      .status(500)
      .json({ message: "Failed to seed learning resources", error: error.message });
  }
});
app.get("/api/learning", async (req, res) => {
  try {
    const { skill, platform, cost } = req.query;
    const query = {};

    if (skill) query.relatedSkills = { $regex: new RegExp(skill, "i") };
    if (platform) query.platform = { $regex: new RegExp(platform, "i") };
    if (cost) query.cost = { $regex: new RegExp(cost, "i") };

    const resources = await LearningResourcesCollection.find(query).toArray();
    res.status(200).json(resources);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch learning resources",
      error: error.message,
    });
  }
});
app.get("/api/learning/:id", async (req, res) => {
  try {
    const resource = await LearningResourcesCollection.findOne({
      _id: new ObjectId(req.params.id),
    });
    if (!resource)
      return res.status(404).json({ message: "Resource not found" });
    res.status(200).json(resource);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch resource",
      error: error.message,
    });
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
