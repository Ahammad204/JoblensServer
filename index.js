//Initial index.js setup for server
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const app = express();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { GoogleGenerativeAI } = require("@google/generative-ai");
//Middleware
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
  })
);
// app.use(
//   cors({
//     origin: ["https://joblenss.netlify.app"],
//     credentials: true,
//   })
// );
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
  const token = req.cookies.token || req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ message: "Unauthorized: No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ message: "Forbidden: Invalid token" });
  }
};
// ... inside run() function, before the User Endpoints ...

// Helper function to map user's general experience to a level for scoring
const mapUserExperience = (userExperience) => {
  // Simplistic mapping based on common job levels.
  const exp = userExperience ? userExperience.toLowerCase() : "";
  if (exp.includes("intern") || exp.includes("0-1") || exp.includes("beginner")) return "Beginner";
  if (exp.includes("entry") || exp.includes("1-3") || exp.includes("junior")) return "Entry-level";
  if (exp.includes("mid") || exp.includes("3-5")) return "Mid-level";
  if (exp.includes("senior") || exp.includes("5+")) return "Senior";
  return "Unknown";
};

// New logic to calculate match score and reasons
const calculateMatchScore = (job, user) => {
  const userSkills = user.skills || [];
  const jobSkills = job.skills || [];
  const userTrack = user.careerTrack || "";
  const userExp = user.experience || "";

  // 1. Skill Overlap (Weight 60%)
  const matchedSkills = jobSkills.filter((skill) =>
    userSkills.some(userSkill => skill.toLowerCase() === userSkill.toLowerCase())
  );
  const missingSkills = jobSkills.filter((skill) =>
    !userSkills.some(userSkill => skill.toLowerCase() === userSkill.toLowerCase())
  );

  const skillScore = jobSkills.length > 0 ? (matchedSkills.length / jobSkills.length) * 60 : 0;

  // 2. Experience Alignment (Weight 20%)
  const jobLevel = job.experienceLevel ? job.experienceLevel.toLowerCase() : "";
  const mappedUserLevel = mapUserExperience(userExp).toLowerCase();

  let expScore = 0;
  let expReason = `Job requires **${job.experienceLevel || 'Unknown'}** experience.`;
  
  if (jobLevel === mappedUserLevel) {
    expScore = 20;
    expReason = "Experience level **Perfect Match**.";
  } else if (mappedUserLevel === "unknown") {
    expScore = 10; // Neutral score if user data is missing
    expReason = "Experience level **Partial Match** (User experience not fully specified).";
  } else if (jobLevel && mappedUserLevel) {
    expReason = `Job requires **${job.experienceLevel}**, your level is **${mappedUserLevel.charAt(0).toUpperCase() + mappedUserLevel.slice(1)}** (Mismatch).`;
  }

  // 3. Career Track Alignment (Weight 20%)
  const trackMatch = userTrack && (
    job.jobType.toLowerCase().includes(userTrack.toLowerCase()) ||
    job.title.toLowerCase().includes(userTrack.toLowerCase())
  );

  const trackScore = trackMatch ? 20 : 0;
  const trackReason = trackMatch
    ? `Career Track **${userTrack}** aligns with job type/title.`
    : `Preferred track **${userTrack || 'N/A'}** does not directly match job type/title.`;

  // Total Score
  const totalScore = Math.round(skillScore + expScore + trackScore);

  // Key Reasons for display
  const matchReasons = [
    `Skills Match: **${matchedSkills.length} of ${jobSkills.length}** required skills.`,
    expReason,
    trackReason,
    matchedSkills.length > 0
      ? `Matches: ${matchedSkills.join(", ")}`
      : "No core skill matches found.",
    missingSkills.length > 0
      ? `Missing: ${missingSkills.join(", ")}`
      : "All required skills match.",
  ];
  
  // External Platforms (Static Guidance) - Dynamic link creation
  const encodedTitle = encodeURIComponent(job.title);
  const platforms = [
    { name: "LinkedIn", url: `https://www.linkedin.com/search/results/all/?keywords=${encodedTitle}` },
    { name: "Glassdoor", url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodedTitle}` },
    { name: "BDjobs", url: `https://www.bdjobs.com/jobsearch.asp?keyword=${encodedTitle}` },
  ];

  return {
    matchPercentage: totalScore,
    keyReasons: matchReasons,
    matchedSkills: matchedSkills, // Included for reference, though not strictly needed for the FE display now
    platforms: platforms
  };
};

// ... replace the existing app.get("/api/jobs/recommend", ...) endpoint definition


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

    // Get recommended jobs for a user
app.get("/api/jobs/recommend", verifyToken, async (req, res) => {
    try {
        const user = await UsersCollection.findOne({ email: req.user.email });
        if (!user) return res.status(404).json({ message: "User not found" });

        // Fetch all jobs
        const allJobs = await JobsCollection.find().toArray();

        // Calculate score for each job and enrich the data
        const recommendedJobs = allJobs
            .map((job) => {
                const matchData = calculateMatchScore(job, user);
                return { 
                    ...job, 
                    ...matchData,
                };
            })
            // Filter out jobs with a match percentage below 30% for relevance
            .filter((job) => job.matchPercentage > 30)
            // Sort by match percentage descending
            .sort((a, b) => b.matchPercentage - a.matchPercentage);

        res.status(200).json(recommendedJobs);
    } catch (err) {
        console.error("Failed to get recommendations:", err);
        res.status(500).json({ message: "Failed to get recommendations", error: err.message });
    }
});
// Get recommended learning resources for a user
app.get("/api/learning/recommend", verifyToken, async (req, res) => {
  try {
    const user = await UsersCollection.findOne({ email: req.user.email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const userSkills = user.skills || [];

    // Fetch all resources
    const allResources = await LearningResourcesCollection.find().toArray();

    // Filter resources that match user's skills
    const recommendedResources = allResources
      .map((res) => {
        const matches = res.relatedSkills.filter((skill) =>
          userSkills.includes(skill)
        );
        return { ...res, matchSkills: matches };
      })
      .filter((res) => res.matchSkills.length > 0);

    res.status(200).json(recommendedResources);
  } catch (err) {
    res.status(500).json({ message: "Failed to get learning recommendations", error: err.message });
  }
});
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
  secure: process.env.NODE_ENV === "production", // only secure in prod
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000,
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
// Save CV analysis results to user profile
app.post("/api/cv/save", verifyToken, async (req, res) => {
  try {
    const { skills, tools, roles, explain } = req.body;

    if (!skills || !tools || !roles) {
      return res.status(400).json({ message: "CV analysis data is required" });
    }

    const result = await UsersCollection.findOneAndUpdate(
      { email: req.user.email },
      {
        $set: {
          skills,
          tools,
          roles,
          cvAnalysis: { explain, updatedAt: new Date() },
        },
      },
      { returnDocument: "after" }
    );

    res.status(200).json({
      message: "CV analysis saved successfully",
      user: result.value,
    });
  } catch (err) {
    console.error("Save CV Analysis Error:", err);
    res.status(500).json({
      message: "Failed to save CV analysis",
      error: err.message,
    });
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
//     app.get("/api/jobs/match", verifyToken, async (req, res) => {
//   try {
//     const user = await UsersCollection.findOne({ email: req.user.email });
//     if (!user) return res.status(404).json({ message: "User not found" });

    

//     const userSkills = user.skills || [];
//     const userExperience = user.experience || ""; // e.g., "Beginner", "Entry-level"
//     const userTrack = user.careerTrack || "";

//     console.log(userSkills)

//     const allJobs = await JobsCollection.find().toArray();

//     const scoredJobs = allJobs.map((job) => {
//       // Skills match
//       const matchedSkills = job.skills.filter((skill) =>
//         userSkills.includes(skill)
//       );
//       const skillScore = (matchedSkills.length / job.skills.length) * 50; // 50% weight

//       // Experience match
//       const expScore = job.experienceLevel
//         .toLowerCase()
//         .includes(userExperience.toLowerCase())
//         ? 25
//         : 0; // 25% weight

//       // Career track / job type match
//       const trackScore = job.jobType
//         .toLowerCase()
//         .includes(userTrack.toLowerCase())
//         ? 25
//         : 0; // 25% weight

//       const totalScore = skillScore + expScore + trackScore;

//       // Key reasons
//       const missingSkills = job.skills.filter(
//         (skill) => !userSkills.includes(skill)
//       );
//       const reasons = [
//         matchedSkills.length
//           ? `Matches: ${matchedSkills.join(", ")}`
//           : "No matching skills",
//         missingSkills.length
//           ? `Missing: ${missingSkills.join(", ")}`
//           : null,
//         expScore ? `Experience matches (${userExperience})` : null,
//         trackScore ? `Track matches (${userTrack})` : null,
//       ]
//         .filter(Boolean)
//         .join("; ");

//       return {
//         ...job,
//         matchScore: Math.round(totalScore),
//         keyReasons: reasons,
//         applyPlatforms: [
//           { name: "LinkedIn", url: "https://www.linkedin.com/jobs/" },
//           { name: "BDJobs", url: "https://www.bdjobs.com/" },
//           { name: "Glassdoor", url: "https://www.glassdoor.com/Job/index.htm" },
//         ],
//       };
//     });

//     // Sort by highest match
//     scoredJobs.sort((a, b) => b.matchScore - a.matchScore);

//     res.status(200).json(scoredJobs);
//   } catch (err) {
//     console.error("Job Match Error:", err);
//     res
//       .status(500)
//       .json({ message: "Failed to get job matches", error: err.message });
//   }
// });


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


// ================= Google Gemini ================
// Gemini CV analysis endpoint


app.post("/api/cv/analyze", verifyToken, async (req, res) => {
  try {
    const { cvText } = req.body;

    if (!cvText) {
      return res.status(400).json({ message: "CV text required" });
    }

    const prompt = `
Extract strictly:
1. Key skills
2. Tools / technologies
3. Relevant roles/domains

Return ONLY raw JSON with keys: skills, tools, roles.
No explanation text.

CV:
${cvText}
`;


    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b:free",
        messages: [
          {
            role: "user",
            content: prompt
          }
        ]
      })
    });

    
    const result = await response.json();
console.log(result)
    const rawText =
      result?.choices?.[0]?.message?.content?.trim() || "{}";

    let clean = rawText;

    if (clean.startsWith("```json")) {
      clean = clean.replace(/```json|```/g, "").trim();
    }

    const parsed = JSON.parse(clean);
    

    res.status(200).json({ data: parsed });
  } catch (err) {
    console.error("OpenRouter Error:", err);
    res.status(500).json({ message: "OpenRouter failed", error: err.message });
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
