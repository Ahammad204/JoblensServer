//Initial index.js setup for server
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const cookieParser = require("cookie-parser");
const nodemailer = require("nodemailer");
const app = express();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
//Middleware
app.use(
  cors({
    origin: ["http://localhost:5173", "https://joblenss.netlify.app"],
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

//port
const port = process.env.PORT || 5000;

//Connect to MongoDB

const { MongoClient, ObjectId } = require("mongodb");

const uri = process.env.MONGODB;

// Password-reset emails (ported from the old server.js
// src/routes/resetPassword.routes.js). Nodemailer is lazy: creating the
// transporter here opens no connection at startup.
const resetTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Create a MongoClient. Do NOT call await client.connect() at startup:
// the driver connects lazily on first use, exactly like the old server.js
// code (whose connect + ping were commented out). Awaiting the connect at
// cold start hangs server selection for 30s and leaves no routes registered.
const client = new MongoClient(uri);

// ... inside run() function, before the User Endpoints ...

// Helper function to map user's general experience to a level for scoring
const mapUserExperience = (userExperience) => {
  // Simplistic mapping based on common job levels.
  const exp = userExperience ? userExperience.toLowerCase() : "";
  if (exp.includes("intern") || exp.includes("0-1") || exp.includes("beginner"))
    return "Beginner";
  if (exp.includes("entry") || exp.includes("1-3") || exp.includes("junior"))
    return "Entry-level";
  if (exp.includes("mid") || exp.includes("3-5")) return "Mid-level";
  if (exp.includes("senior") || exp.includes("5+")) return "Senior";
  return "Unknown";
};

// Escape regex special characters so user-supplied filter values are
// matched literally, not as regex syntax (e.g. "C++", "Node.js").
const escapeRegExp = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// New logic to calculate match score and reasons
const calculateMatchScore = (job, user) => {
  const userSkills = user.skills || [];
  const jobSkills = job.skills || [];
  userTrack = user.careerTrack || "";
  const userExp = user.experience || "";

  // 1. Skill Overlap (Weight 60%)
  const matchedSkills = jobSkills.filter((skill) =>
    userSkills.some(
      (userSkill) => skill.toLowerCase() === userSkill.toLowerCase()
    )
  );
  const missingSkills = jobSkills.filter(
    (skill) =>
      !userSkills.some(
        (userSkill) => skill.toLowerCase() === userSkill.toLowerCase()
      )
  );

  const skillScore =
    jobSkills.length > 0 ? (matchedSkills.length / jobSkills.length) * 60 : 0;

  // 2. Experience Alignment (Weight 20%)
  const jobLevel = job.experienceLevel ? job.experienceLevel.toLowerCase() : "";
  const mappedUserLevel = mapUserExperience(userExp).toLowerCase();

  let expScore = 0;
  let expReason = `Job requires **${
    job.experienceLevel || "Unknown"
  }** experience.`;

  if (jobLevel === mappedUserLevel) {
    expScore = 20;
    expReason = "Experience level **Perfect Match**.";
  } else if (mappedUserLevel === "unknown") {
    expScore = 10; // Neutral score if user data is missing
    expReason =
      "Experience level **Partial Match** (User experience not fully specified).";
  } else if (jobLevel && mappedUserLevel) {
    expReason = `Job requires **${job.experienceLevel}**, your level is **${
      mappedUserLevel.charAt(0).toUpperCase() + mappedUserLevel.slice(1)
    }** (Mismatch).`;
  }

  // 3. Career Track Alignment (Weight 20%)
  const trackMatch =
    userTrack &&
    (job.jobType.toLowerCase().includes(userTrack.toLowerCase()) ||
      job.title.toLowerCase().includes(userTrack.toLowerCase()));

  const trackScore = trackMatch ? 20 : 0;
  const trackReason = trackMatch
    ? `Career Track **${userTrack}** aligns with job type/title.`
    : `Preferred track **${
        userTrack || "N/A"
      }** does not directly match job type/title.`;

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
    {
      name: "LinkedIn",
      url: `https://www.linkedin.com/search/results/all/?keywords=${encodedTitle}`,
    },
    {
      name: "Glassdoor",
      url: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodedTitle}`,
    },
    {
      name: "BDjobs",
      url: `https://www.bdjobs.com/jobsearch.asp?keyword=${encodedTitle}`,
    },
  ];

  return {
    matchPercentage: totalScore,
    keyReasons: matchReasons,
    missingSkills: missingSkills, // <-- NEW: Return missing skills
    platforms: platforms,
  };
};

// ============ Local-only AI: trained model + rule-based helpers ============
// These replace every outside-LLM call. The only outside service left is
// the team's own trained Linear-SVM classifier (ML_SERVICE_URL, served
// by ml-service/); everything else is local, deterministic logic.

// Shared ML-service call (same URL / timeout / AbortController pattern as
// the old /api/ml/predict proxy). Throws on any failure — callers that
// treat the prediction as optional must catch.
const callMLService = async (cvText) => {
  const mlServiceUrl = process.env.ML_SERVICE_URL;
  if (!mlServiceUrl) {
    throw new Error("ML service is not configured (set ML_SERVICE_URL).");
  }
  const controller = new AbortController();
  const timeoutMs = Number(process.env.ML_TIMEOUT_MS || 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${mlServiceUrl.replace(/\/$/, "")}/predict`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cv_text: cvText }),
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const err = new Error(
        `ML service returned ${response.status}${
          detail ? `: ${detail.slice(0, 300)}` : ""
        }`
      );
      err.mlUpstream = true;
      err.detail = detail.slice(0, 300);
      throw err;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

// "INFORMATION-TECHNOLOGY" -> "Information-Technology".
// Short acronym categories (HR, IT, BPO) keep their uppercase form.
const titleCaseCategory = (s) => {
  const raw = String(s || "").trim();
  if (/^(HR|IT|BPO)$/i.test(raw)) return raw.toUpperCase();
  return raw
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

// Case-insensitive term match on lowercased text. Single-word terms use
// word boundaries (so "go" never matches "google" and "java" never
// matches "javascript"); multiword terms use a plain substring test.
// escapeRegExp (defined above) keeps terms like "C++" literal.
const matchTerm = (lowerText, term) => {
  if (term.includes(" ")) return lowerText.includes(term);
  return new RegExp(
    `(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`
  ).test(lowerText);
};

// [display name, ...match terms]. First term defaults to the display
// name lowercased; extra terms are aliases.
const LOCAL_SKILLS = [
  ["JavaScript", "javascript", "js"],
  ["TypeScript", "typescript", "ts"],
  ["React", "react", "react.js", "reactjs"],
  ["Node.js", "node.js", "nodejs", "node js"],
  ["Express", "express", "express.js"],
  ["MongoDB", "mongodb", "mongo"],
  ["MySQL", "mysql"],
  ["PostgreSQL", "postgresql", "postgres"],
  ["Python", "python"],
  ["Django", "django"],
  ["Flask", "flask"],
  ["Java", "java"],
  ["Spring", "spring", "spring boot"],
  ["C++", "c++"],
  ["C#", "c#", "c sharp"],
  ["C", "c programming", "c language"],
  ["Go", "golang", "go programming"],
  ["PHP", "php"],
  ["Laravel", "laravel"],
  ["HTML", "html", "html5"],
  ["CSS", "css", "css3"],
  ["Tailwind CSS", "tailwind", "tailwind css"],
  ["Bootstrap", "bootstrap"],
  ["Next.js", "next.js", "nextjs"],
  ["Vue.js", "vue", "vue.js"],
  ["Angular", "angular"],
  ["Docker", "docker"],
  ["Kubernetes", "kubernetes", "k8s"],
  ["AWS", "aws", "amazon web services"],
  ["Firebase", "firebase"],
  ["Figma", "figma"],
  ["Postman", "postman"],
  ["Git", "git"],
  ["GitHub", "github"],
  ["Redux", "redux"],
  ["GraphQL", "graphql"],
  ["REST API", "rest api", "restful"],
  ["SQL", "sql"],
  ["Linux", "linux"],
  ["Machine Learning", "machine learning", "ml"],
  ["Deep Learning", "deep learning"],
  ["NLP", "nlp", "natural language processing"],
  ["Computer Vision", "computer vision"],
  ["Data Analysis", "data analysis", "data analytics"],
  ["Excel", "excel", "ms excel"],
  ["WordPress", "wordpress"],
  ["Adobe XD", "adobe xd", "xd"],
  ["UI/UX Design", "ui/ux", "ui design", "ux design"],
  ["SEO", "seo"],
  ["Digital Marketing", "digital marketing"],
  ["Content Writing", "content writing"],
  ["Video Editing", "video editing"],
  ["Networking", "networking", "computer networks"],
  ["Cybersecurity", "cybersecurity", "cyber security"],
  ["Arduino", "arduino"],
  ["IoT", "iot", "internet of things"],
  ["Raspberry Pi", "raspberry pi"],
  ["MATLAB", "matlab"],
  ["AutoCAD", "autocad"],
  ["Flutter", "flutter"],
  ["React Native", "react native"],
  ["Android", "android"],
  ["iOS", "ios"],
  ["Kotlin", "kotlin"],
  ["Swift", "swift"],
  ["Data Structures", "data structures"],
  ["Algorithms", "algorithms", "algorithm"],
  ["OOP", "oop", "object-oriented programming"],
  ["Communication", "communication"],
  ["Leadership", "leadership"],
  ["Problem Solving", "problem solving", "problem-solving"],
  ["Teamwork", "teamwork", "team work"],
  ["Time Management", "time management"],
];

const LOCAL_TOOLS = [
  ["Git", "git"],
  ["GitHub", "github"],
  ["VS Code", "visual studio code", "vs code"],
  ["Docker", "docker"],
  ["Postman", "postman"],
  ["Figma", "figma"],
  ["Jira", "jira"],
  ["Slack", "slack"],
  ["Trello", "trello"],
  ["Notion", "notion"],
  ["Chrome DevTools", "chrome devtools", "devtools"],
  ["MySQL Workbench", "mysql workbench"],
  ["MongoDB Compass", "mongodb compass"],
  ["Photoshop", "photoshop"],
  ["Illustrator", "illustrator"],
  ["Canva", "canva"],
  ["Tableau", "tableau"],
  ["Power BI", "power bi"],
  ["Jupyter Notebook", "jupyter"],
  ["PyCharm", "pycharm"],
  ["IntelliJ IDEA", "intellij"],
  ["Android Studio", "android studio"],
  ["Xcode", "xcode"],
  ["Vercel", "vercel"],
  ["Netlify", "netlify"],
  ["Heroku", "heroku"],
  ["Google Cloud", "google cloud", "gcp"],
  ["npm", "npm"],
  ["Yarn", "yarn"],
  ["Jest", "jest"],
  ["Selenium", "selenium"],
  ["Microsoft Word", "microsoft word", "ms word"],
  ["PowerPoint", "powerpoint", "ms powerpoint"],
];

const LOCAL_ROLES = [
  ["Frontend Developer", "frontend", "front-end", "front end"],
  ["Backend Developer", "backend", "back-end", "back end"],
  ["Full Stack Developer", "full stack", "full-stack"],
  ["Web Developer", "web developer", "web development"],
  ["Software Engineer", "software engineer", "software developer", "software development"],
  ["Mobile Developer", "mobile developer", "mobile app", "android developer", "ios developer"],
  ["Data Scientist", "data scientist", "data science"],
  ["Data Analyst", "data analyst", "data analysis"],
  ["Machine Learning Engineer", "machine learning engineer", "ml engineer"],
  ["DevOps Engineer", "devops"],
  ["UI/UX Designer", "ui/ux designer", "ux designer", "ui designer"],
  ["Graphic Designer", "graphic designer", "graphic design"],
  ["QA Engineer", "qa engineer", "quality assurance", "software tester", "qa tester"],
  ["Database Administrator", "database administrator", "dba"],
  ["Network Engineer", "network engineer"],
  ["Cybersecurity Analyst", "cybersecurity analyst", "cyber security analyst", "security analyst", "penetration tester"],
  ["Project Manager", "project manager"],
  ["Business Analyst", "business analyst"],
  ["Digital Marketer", "digital marketer", "digital marketing"],
  ["Accountant", "accountant", "accounting"],
  ["Content Writer", "content writer"],
  ["HR", "human resource", "human resources", "hr manager"],
];

// Local skill/tool/role extraction from free CV text. Keyword roles only —
// the trained-model role is added by callers that have a prediction.
const extractLocal = (cvText) => {
  const lower = String(cvText || "").toLowerCase();
  const pick = (dict) => {
    const found = [];
    for (const [name, ...terms] of dict) {
      const allTerms = terms.length > 0 ? terms : [name.toLowerCase()];
      if (allTerms.some((t) => matchTerm(lower, t))) found.push(name);
    }
    return found;
  };
  return {
    skills: pick(LOCAL_SKILLS),
    tools: pick(LOCAL_TOOLS),
    roles: pick(LOCAL_ROLES),
  };
};

// Total years of experience parsed from CV text. Sums year ranges
// ("2021 - Present" counts to 2026, the current year) and falls back to
// the largest "N years experience" mention. Never invented: 0 if nothing
// is stated.
const parseExperienceYears = (text) => {
  const t = String(text || "");
  let rangeYears = 0;
  const rangeRe = /((?:19|20)\d{2})\s*[–—-]\s*((?:19|20)\d{2}|present|current|now)/gi;
  let m;
  while ((m = rangeRe.exec(t)) !== null) {
    const start = parseInt(m[1], 10);
    const end = /^\d+$/.test(m[2]) ? Math.min(parseInt(m[2], 10), 2026) : 2026;
    if (end > start) rangeYears += end - start;
  }
  let statedYears = 0;
  const yearsRe = /(\d+)\+?\s*years?(?:\s+of)?\s+(?:experience|exp)\b/gi;
  while ((m = yearsRe.exec(t)) !== null) {
    statedYears = Math.max(statedYears, parseInt(m[1], 10));
  }
  return Math.min(Math.max(rangeYears, statedYears), 40);
};

// Education lines from CV text: lines that name a degree / level / field.
const parseEducation = (text) => {
  const keywords = [
    "bsc", "b.sc", "bachelor", "master", "m.sc", "msc", "mba", "bba",
    "diploma", "hsc", "ssc", "computer science", "cse", "phd",
  ];
  const found = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^[-•*]\s*/, "");
    if (!trimmed || trimmed.length > 160) continue;
    if (
      keywords.some((k) => trimmed.toLowerCase().includes(k)) &&
      !found.includes(trimmed)
    ) {
      found.push(trimmed);
    }
    if (found.length >= 5) break;
  }
  return found;
};


async function run() {
  try {
    // NOTE: no explicit client.connect() / ping here on purpose — the driver
    // connects lazily on first query, like the old server.js code.

    // ======================== All Collections =========================
    const UsersCollection = client.db("UserDB").collection("Users");
    const JobsCollection = client.db("JobsDB").collection("Jobs");
    const LearningResourcesCollection = client
      .db("LearningDB")
      .collection("LearningResources");
    const verifyToken = (req, res, next) => {
      const token =
        req.cookies.token || req.headers.authorization?.split(" ")[1];

      if (!token)
        return res.status(401).json({ message: "Unauthorized: No token" });

      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
      } catch (err) {
        res.status(403).json({ message: "Forbidden: Invalid token" });
      }
    };
    // Admin-only gate: same DB role check as the inline checks in
    // DELETE /api/jobs/:id and GET /api/admin/analytics (the JWT
    // carries only the email, so the role is read from the DB).
    const verifyAdmin = async (req, res, next) => {
      const user = await UsersCollection.findOne({ email: req.user.email });
      if (!user || user.role !== "admin") {
        return res.status(403).json({ message: "Forbidden: Admins only" });
      }
      next();
    };
   // Assuming Express + MongoDB
app.post("/api/chat", verifyToken, async (req, res) => {
  try {
    const { message } = req.body;

    const userEmail = req.user.email;

    if (!message) {
      return res.status(400).json({ error: "Message is required" });
    }

    // Fetch user from DB by email (profile + stored ML prediction + roadmap)
    const user = await UsersCollection.findOne(
      { email: userEmail },
      { projection: { name: 1, skills: 1, resume: 1, email: 1, role: 1, mlPrediction: 1, careerTrack: 1, education: 1, experience: 1, roadmap: 1 } }
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Rule-based career assistant: answers ONLY from the user's stored
    // profile, their stored ML prediction, and the Jobs/Learning DB.
    // Replies are PLAIN TEXT (no markdown) — the clients render raw text.
    const text = String(message).toLowerCase();
    const name = user.name || "there";
    const userSkills = Array.isArray(user.skills) ? user.skills : [];
    const userSkillsLower = userSkills.map((s) => String(s).toLowerCase());
    const skillList =
      userSkills.length > 0 ? userSkills.join(", ") : "No skills listed yet";

    const helpText =
      "Here is what I can do:\n" +
      "- Find jobs that match your skills — ask \"What jobs fit me?\"\n" +
      "- Suggest learning resources for skills you are missing — ask \"What should I learn?\"\n" +
      "- Summarize your roadmap — ask \"Show my roadmap\"\n" +
      "- Show your profile and ML prediction — ask \"What is my prediction?\"\n" +
      "- Give CV advice — ask \"How is my CV?\"";

    let reply;

    if (/\b(hi|hello|hey|salam|assalamu alaikum|good morning|good afternoon|good evening)\b/.test(text)) {
      reply =
        `Hi ${name}! I can help you find jobs that match your skills, ` +
        `suggest learning resources for your skill gaps, summarize your ` +
        `roadmap, or show your profile and ML prediction. What would you like to do?`;
    } else if (
      text.includes("help") ||
      text.includes("what can you do") ||
      text.includes("how do i") ||
      text.includes("how to")
    ) {
      reply = helpText;
    } else if (
      text.includes("job") ||
      text.includes("recommend") ||
      text.includes("match") ||
      text.includes("fit")
    ) {
      // Top 3 jobs by skill overlap: matched / job skills.
      if (userSkills.length === 0) {
        reply =
          "You have no skills listed in your profile yet. Add your skills " +
          "on the profile page first, then ask me again and I will match jobs for you.";
      } else {
        const allJobs = await JobsCollection.find().toArray();
        const scored = allJobs
          .map((job) => {
            const jobSkills = Array.isArray(job.skills) ? job.skills : [];
            const matched = jobSkills.filter((skill) =>
              userSkillsLower.includes(String(skill).toLowerCase())
            );
            const missing = jobSkills.filter(
              (skill) => !userSkillsLower.includes(String(skill).toLowerCase())
            );
            const pct =
              jobSkills.length > 0
                ? Math.round((matched.length / jobSkills.length) * 100)
                : 0;
            return { job, matched, missing, pct };
          })
          .filter((s) => s.pct > 0)
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 3);
        if (scored.length === 0) {
          reply =
            "No jobs in the database match your current skills yet. Try " +
            "adding more skills to your profile, or check the Jobs page for the full list.";
        } else {
          const lines = scored.map((s, i) => {
            const matchedText =
              s.matched.length > 0 ? `Matches: ${s.matched.join(", ")}` : "No skill matches";
            const missingText =
              s.missing.length > 0
                ? `Missing: ${s.missing.join(", ")}`
                : "No skills missing";
            return `${i + 1}. ${s.job.title} at ${s.job.company || "Unknown"} — ${s.pct}% skill match (${matchedText}; ${missingText})`;
          });
          reply = `Top jobs for you:\n${lines.join("\n")}`;
        }
      }
    } else if (
      text.includes("learn") ||
      text.includes("skill gap") ||
      text.includes("course") ||
      text.includes("resource") ||
      text.includes("study")
    ) {
      // Missing skills: most frequent job skills the user does not have.
      // If no gap is known, fall back to the user's own skills.
      const allJobs = await JobsCollection.find().toArray();
      const missingCount = {};
      for (const job of allJobs) {
        for (const skill of job.skills || []) {
          if (!userSkillsLower.includes(String(skill).toLowerCase())) {
            missingCount[skill] = (missingCount[skill] || 0) + 1;
          }
        }
      }
      let targetSkills = Object.entries(missingCount)
        .sort((a, b) => b[1] - a[1])
        .map(([skill]) => skill)
        .slice(0, 10);
      if (targetSkills.length === 0) targetSkills = userSkills;
      if (targetSkills.length === 0) {
        reply =
          "You have no skills listed in your profile yet, so I cannot tell " +
          "what you are missing. Add your skills on the profile page first.";
      } else {
        const targetLower = targetSkills.map((s) => String(s).toLowerCase());
        const allResources = await LearningResourcesCollection.find().toArray();
        const scored = allResources
          .map((resource) => {
            const covers = (resource.relatedSkills || []).filter((skill) =>
              targetLower.includes(String(skill).toLowerCase())
            );
            return { resource, covers };
          })
          .filter((s) => s.covers.length > 0)
          .sort((a, b) => b.covers.length - a.covers.length)
          .slice(0, 5);
        if (scored.length === 0) {
          reply =
            `I could not find learning resources for ${targetSkills.slice(0, 3).join(", ")} ` +
            `in the database yet. Check the Learning Resources page for the full list.`;
        } else {
          const lines = scored.map((s, i) => {
            return `${i + 1}. ${s.resource.title} (${s.resource.platform || "Learning Resources"}) — Covers: ${s.covers.join(", ")}`;
          });
          reply =
            `Learning resources for your missing skills (${targetSkills.slice(0, 5).join(", ")}):\n${lines.join("\n")}`;
        }
      }
    } else if (text.includes("roadmap")) {
      const roadmap = user.roadmap;
      if (roadmap && roadmap.targetRole) {
        const phaseNames = Array.isArray(roadmap.phases)
          ? roadmap.phases.map((p) => p.phaseName).filter(Boolean)
          : [];
        reply =
          `Your roadmap: ${roadmap.targetRole}, timeframe ${roadmap.timeframe || "not set"}.` +
          (phaseNames.length > 0 ? ` Phases: ${phaseNames.join("; ")}.` : "") +
          ` Open the Roadmap page on your dashboard to see the full plan.`;
      } else {
        reply =
          "You do not have a roadmap yet. Generate one from the Roadmap " +
          "page on your dashboard by choosing a target role and timeframe.";
      }
    } else if (
      text.includes("profile") ||
      text.includes("who am i") ||
      text.includes("my skills") ||
      text.includes("my prediction") ||
      text.includes("prediction")
    ) {
      const pred = user.mlPrediction;
      const category =
        (pred && pred.predicted_category) ||
        (pred && pred.data && pred.data.predicted_category) ||
        (typeof pred === "string" ? pred : null);
      const predictionText = category
        ? `Your last ML prediction: ${titleCaseCategory(category)}.`
        : "No ML prediction yet — upload your CV on the CV Analysis page and I can predict a role for you.";
      reply =
        `Your profile:\n` +
        `Name: ${user.name || "Not provided"}\n` +
        `Email: ${user.email}\n` +
        `Career track: ${user.careerTrack || "Not set"}\n` +
        `Skills: ${skillList}\n` +
        `Education: ${user.education || "Not provided"}\n` +
        `${predictionText}`;
    } else if (text.includes("resume") || text.includes("cv")) {
      if (user.resume) {
        reply =
          `You have a CV saved on your profile. It lists ${userSkills.length} skill(s). ` +
          `Upload it again on the CV Analysis page any time to refresh your skills and ML ` +
          `prediction, and use the CV Generator to build a clean CV from your profile.`;
      } else {
        reply =
          "You have no CV saved yet. Add your CV text on the CV Analysis " +
          "page so I can extract your skills and predict a matching role.";
      }
    } else {
      reply =
        "I can help with jobs, learning resources, your roadmap, your " +
        "profile and ML prediction, or CV advice. For example, ask: \"What jobs fit me?\"";
    }

    res.status(200).json({ reply });
  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ error: err.message });
  }
});




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
        res
          .status(500)
          .json({
            message: "Failed to get recommendations",
            error: err.message,
          });
      }
    });

    // NEW ENDPOINT: Get learning resources based on a list of MISSING skills
    app.post(
      "/api/jobs/skill-gap-recommendations",
      verifyToken,
      async (req, res) => {
        try {
          const { missingSkills } = req.body; // Expecting an array of skills

          if (!missingSkills || missingSkills.length === 0) {
            return res.status(200).json([]);
          }

          // Find resources that cover any of the missing skills
          const recommendedResources = await LearningResourcesCollection.find({
            relatedSkills: { $in: missingSkills },
          })
            .limit(5)
            .toArray(); // Limit to 5 for a quick view

          // Enrich the resource data to show which missing skills it covers
          const resourcesWithMatches = recommendedResources.map((resource) => {
            const relevantMissingSkills = resource.relatedSkills.filter(
              (skill) => missingSkills.includes(skill)
            );
            return {
              ...resource,
              relevantMissingSkills, // The skills that close the gap
            };
          });

          res.status(200).json(resourcesWithMatches);
        } catch (err) {
          console.error("Failed to get skill gap recommendations:", err);
          res
            .status(500)
            .json({
              message: "Failed to get skill gap recommendations",
              error: err.message,
            });
        }
      }
    );
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
        res
          .status(500)
          .json({
            message: "Failed to get learning recommendations",
            error: err.message,
          });
      }
    });
    // NEW ENDPOINT: Generate personalized roadmap using AI
    app.post("/api/roadmap/generate", verifyToken, async (req, res) => {
      try {
        const { targetRole, timeframe, learningTime, currentSkills } = req.body;
        const user = await UsersCollection.findOne({ email: req.user.email });

        if (!user) return res.status(404).json({ message: "User not found" });

        // Rule-based roadmap: needed skills come from Jobs whose title
        // matches the target role, most frequent first. Guard currentSkills
        // — the client sends user.skills, but it may be absent.
        const current = Array.isArray(currentSkills) ? currentSkills : [];
        const currentLower = current.map((s) => String(s).toLowerCase());

        const countSkills = (jobs) => {
          const counts = {};
          for (const job of jobs) {
            for (const skill of job.skills || []) {
              if (!currentLower.includes(String(skill).toLowerCase())) {
                counts[skill] = (counts[skill] || 0) + 1;
              }
            }
          }
          return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([skill]) => skill);
        };

        const matchingJobs = await JobsCollection.find({
          title: {
            $regex: escapeRegExp(String(targetRole || "")),
            $options: "i",
          },
        }).toArray();
        let neededSkills = countSkills(matchingJobs).slice(0, 8);
        if (neededSkills.length === 0) {
          // No job matches the role — fall back to the most common job
          // skills overall so the roadmap is never empty.
          const allJobs = await JobsCollection.find().toArray();
          neededSkills = countSkills(allJobs).slice(0, 8);
        }

        // Up to 2 learning resources per needed skill.
        const resourceBySkill = {};
        for (const skill of neededSkills) {
          const resources = await LearningResourcesCollection.find({
            relatedSkills: { $regex: escapeRegExp(skill), $options: "i" },
          })
            .limit(2)
            .toArray();
          resourceBySkill[skill] = resources;
        }

        const monthsMatch = String(timeframe || "").match(/(\d+)/);
        const months = monthsMatch ? parseInt(monthsMatch[1], 10) : 3;
        // A 1-month timeframe is planned week by week.
        const unit = months === 1 ? "Week" : "Month";

        const stepFor = (skill) => {
          const resource = (resourceBySkill[skill] || [])[0];
          return {
            topic: skill,
            details: resource
              ? `Learn ${skill} with '${resource.title}' (${resource.platform || "Learning Resources"})`
              : `Find a course for ${skill} on the Learning Resources page`,
            projectIdea: `Build a small ${skill} demo project and add it to your CV`,
          };
        };
        const fallbackStep = (label) => ({
          topic: `Learn the fundamentals of ${targetRole || "your target role"}`,
          details: `Study the core concepts behind ${targetRole || "your target role"} from the Learning Resources page.`,
          projectIdea: `Build a small ${targetRole || "target-role"} demo project and add it to your CV`,
        });

        const perPhase = Math.ceil(neededSkills.length / 3) || 1;
        const phaseSkills = [0, 1, 2].map((i) =>
          neededSkills.slice(i * perPhase, (i + 1) * perPhase)
        );
        const stepsFor = (group, label) =>
          group.length > 0 ? group.map(stepFor) : [fallbackStep(label)];

        // Phase 3 always ends with an application step.
        const phase3Steps = stepsFor(phaseSkills[2], "Phase 3");
        phase3Steps.push({
          topic: "Apply for roles",
          details: `Start applying for ${targetRole || "target"} roles and tailor your CV to each job.`,
          projectIdea: "Track every application on your dashboard.",
        });

        const newRoadmap = {
          title: `Roadmap to ${targetRole}`,
          targetRole: targetRole,
          currentSkills: current,
          timeframe: timeframe,
          learningTime: learningTime,
          applicationTime:
            months === 1 ? "End of Week 3" : `End of Month ${months}`,
          phases: [
            {
              phaseName: `Phase 1: Foundations (${unit} 1)`,
              goal: `Build a strong foundation in the core technologies for ${targetRole}.`,
              steps: stepsFor(phaseSkills[0], "Phase 1"),
            },
            {
              phaseName: `Phase 2: Core Skills (${unit} 2)`,
              goal: `Go deeper into the core skills for ${targetRole} and build working knowledge.`,
              steps: stepsFor(phaseSkills[1], "Phase 2"),
            },
            {
              phaseName: `Phase 3: Projects & Applications (${unit} 3)`,
              goal: `Prove the skills with projects and start applying for ${targetRole} roles.`,
              steps: phase3Steps,
            },
          ],
        };

        // Save the roadmap to the user's profile
        await UsersCollection.updateOne(
          { email: req.user.email },
          { $set: { roadmap: newRoadmap } }
        );

        // Send success response back to the client
        res.status(200).json(newRoadmap);
      } catch (err) {
        console.error("Failed to generate and save roadmap:", err);
        res.status(500).json({
          message:
            "Failed to generate roadmap due to a server error. Check server logs.",
          error: err.message,
        });
      }
    });
    // NEW ENDPOINT: Get user's saved roadmap
    app.get("/api/roadmap", verifyToken, async (req, res) => {
      try {
        const user = await UsersCollection.findOne(
          { email: req.user.email },
          { projection: { roadmap: 1 } }
        );
        if (!user || !user.roadmap) {
          return res.status(404).json({ message: "Roadmap not found" });
        }
        res.status(200).json(user.roadmap);
      } catch (err) {
        console.error("Roadmap Fetch Error:", err);
        res
          .status(500)
          .json({ message: "Failed to fetch roadmap", error: err.message });
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
        const { password: _password, ...safeUser } = user;
        res.status(200).json({ message: "Login successful", user: safeUser });
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

    // POST /api/forgot-password - Send reset link to email
    // (ported from the old server.js src/routes/resetPassword.routes.js)
    app.post("/api/forgot-password", async (req, res) => {
      try {
        const { email } = req.body;

        const user = await UsersCollection.findOne({ email });
        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        // Create a reset token (expires in 15 minutes)
        const resetToken = jwt.sign({ email }, process.env.JWT_SECRET, {
          expiresIn: "15m",
        });

        // Send email with reset link
        const resetLink = `${process.env.CLIENT_URL || "https://joblenss.netlify.app"}/reset-password/${resetToken}`;

        await resetTransporter.sendMail({
          from: process.env.EMAIL_USER,
          to: email,
          subject: "Joblens - Password Reset",
          html: `
            <h2>Password Reset Request</h2>
            <p>Click the link below to reset your password. This link expires in 15 minutes.</p>
            <a href="${resetLink}">${resetLink}</a>
            <p>If you didn't request this, please ignore this email.</p>
          `,
        });

        res.status(200).json({ message: "Reset link sent to your email" });
      } catch (error) {
        console.error("Forgot password error:", error);
        res.status(500).json({ message: "Failed to send reset email", error: error.message });
      }
    });

    // POST /api/reset-password - Reset password with token
    app.post("/api/reset-password", async (req, res) => {
      try {
        const { token, newPassword } = req.body;

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await UsersCollection.updateOne(
          { email: decoded.email },
          { $set: { password: hashedPassword } }
        );

        res.status(200).json({ message: "Password reset successful" });
      } catch (error) {
        if (error.name === "TokenExpiredError") {
          return res.status(400).json({ message: "Reset link has expired" });
        }
        res.status(400).json({ message: "Invalid reset token" });
      }
    });

    //Check if user is logged in
    app.get("/api/me", async (req, res) => {
      try {
        const token = req.cookies.token;
        if (!token) return res.status(401).json({ message: "Unauthorized" });

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await UsersCollection.findOne({ email: decoded.email });

        if (!user) return res.status(404).json({ message: "User not found" });

        const { password, ...safeUser } = user;
        res.status(200).json({ user: safeUser });
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

        const { password, ...safeUser } = result.value || {};
        res.status(200).json(safeUser);
      } catch (err) {
        console.error("Profile Update Error:", err);
        res
          .status(500)
          .json({ message: "Failed to update profile", error: err.message });
      }
    });
    //Check admin or not
    app.get("/users/admin/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = await UsersCollection.findOne({ email });

      res.send({ isAdmin: user?.role === "admin" });
    });
    

    // Save CV analysis results to user profile
    app.post("/api/cv/save", verifyToken, async (req, res) => {
      try {
        const { skills, tools, roles, explain, mlPrediction } = req.body;

        if (!skills || !tools || !roles) {
          return res
            .status(400)
            .json({ message: "CV analysis data is required" });
        }

        const result = await UsersCollection.findOneAndUpdate(
          { email: req.user.email },
          {
            $set: {
              skills,
              tools,
              roles,
              cvAnalysis: { explain, updatedAt: new Date() },
              ...(mlPrediction ? { mlPrediction } : {}),
            },
          },
          { returnDocument: "after" }
        );

        const { password, ...safeUser } = result.value || {};
        res.status(200).json({
          message: "CV analysis saved successfully",
          user: safeUser,
        });
      } catch (err) {
        console.error("Save CV Analysis Error:", err);
        res.status(500).json({
          message: "Failed to save CV analysis",
          error: err.message,
        });
      }
    });
    // POST /api/cv/generate
app.post("/api/cv/generate", verifyToken, async (req, res) => {
  try {
    const user = await UsersCollection.findOne({ email: req.user.email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // Template-based CV built ONLY from the user's stored profile/resume.
    // Nothing is invented: no company, year count, or project is made up.
    const resumeText = user.resume || "";
    const extracted = extractLocal(resumeText);
    const skills =
      Array.isArray(user.skills) && user.skills.length > 0
        ? user.skills
        : extracted.skills;
    const tools =
      Array.isArray(user.tools) && user.tools.length > 0
        ? user.tools
        : extracted.tools;

    // Predicted role from the team's own trained model (non-fatal).
    let predictedRole = null;
    if (resumeText) {
      try {
        const prediction = await callMLService(resumeText);
        if (prediction && prediction.predicted_category) {
          predictedRole = titleCaseCategory(prediction.predicted_category);
        }
      } catch (err) {
        console.error("CV Generate: ML prediction unavailable:", err.message);
      }
    }
    const role = predictedRole || user.careerTrack || "professional";
    const years = parseExperienceYears(resumeText || user.experience || "");
    const educationLines = parseEducation(resumeText);
    const educationText =
      user.education || (educationLines.length > 0 ? educationLines[0] : "");

    // Professional summary — only real data.
    const topSkills = skills.slice(0, 5);
    let professionalSummary = `${user.name || "Candidate"} is a ${role}`;
    if (topSkills.length > 0) {
      professionalSummary += ` skilled in ${topSkills.join(", ")}`;
    }
    if (years > 0) {
      professionalSummary += ` with ${years} year${years === 1 ? "" : "s"} of experience`;
    }
    if (educationText) {
      professionalSummary += `. Education: ${educationText}`;
    }
    professionalSummary += ".";

    // Conservative experience parser: only a line that names a role, a
    // company (via "at" / "@"), and a year range becomes an entry.
    const experience = [];
    for (const rawLine of resumeText.split(/\r?\n/)) {
      const line = rawLine.trim().replace(/^[-•*]\s*/, "");
      const m = line.match(
        /^(.+?)\s+(?:at|@)\s+(.+?)\s+((?:19|20)\d{2}\s*[–—-]\s*(?:(?:19|20)\d{2}|Present|Current|Now))\s*$/i
      );
      if (m) {
        const used = extracted.skills.filter((s) =>
          line.toLowerCase().includes(s.toLowerCase())
        );
        experience.push({
          role: m[1].trim(),
          company: m[2].trim(),
          duration: m[3].trim(),
          description:
            used.length > 0 ? [`Skills used: ${used.join(", ")}`] : [],
        });
      }
      if (experience.length >= 5) break;
    }

    // Projects: only from an explicit "Projects" section in the resume.
    const projects = [];
    const lines = resumeText.split(/\r?\n/);
    let inProjects = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^projects?\s*:?\s*$/i.test(line)) {
        inProjects = true;
        continue;
      }
      if (inProjects) {
        if (/^(education|experience|skills|certifications?|contact|summary|awards?)\b/i.test(line)) {
          break;
        }
        const bullet = line.replace(/^[-•*]\s*/, "");
        if (bullet.length > 10) {
          projects.push({ title: bullet.slice(0, 60), description: [bullet] });
        }
        if (projects.length >= 5) break;
      }
    }

    // Recommendations: generic honest tips, plus one ML-role tip when a
    // prediction exists.
    const recommendations = [
      "Add a portfolio link to showcase your best work.",
      "List your top 3 projects with measurable outcomes.",
    ];
    if (predictedRole) {
      recommendations.push(
        `Target ${predictedRole} roles — your CV matches this category.`
      );
    }

    const cvData = {
      personalInfo: {
        name: user.name,
        email: user.email,
        education: user.education || "",
      },
      professionalSummary,
      experience,
      projects,
      skills,
      tools,
      recommendations,
    };

    // Save CV data to user profile
    await UsersCollection.updateOne(
      { email: req.user.email },
      { $set: { generatedCV: cvData } }
    );

    res.status(200).json(cvData);
  } catch (err) {
    console.error("CV Generation Error:", err);
    res.status(500).json({ message: err.message });
  }
});

    // ============================ Job Endpoints =======================================
    // ===================== Seed Jobs =====================
    app.post("/api/jobs/seed", verifyToken, verifyAdmin, async (req, res) => {
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
    // DELETE a job by ID
app.delete("/api/jobs/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Optional: Check if the user is admin before allowing deletion
    const user = await UsersCollection.findOne({ email: req.user.email });
    if (!user || user.role !== "admin") {
      return res.status(403).json({ message: "Forbidden: Admins only" });
    }

    const result = await JobsCollection.deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Job not found" });
    }

    res.status(200).json({ message: "Job deleted successfully" });
  } catch (err) {
    console.error("Delete Job Error:", err);
    res.status(500).json({ message: "Failed to delete job", error: err.message });
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
    app.post("/api/learning/seed", verifyToken, verifyAdmin, async (req, res) => {
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
        res
          .status(201)
          .json({ message: "Learning resources seeded successfully" });
      } catch (error) {
        console.error("Learning Seed Error:", error);
        res
          .status(500)
          .json({
            message: "Failed to seed learning resources",
            error: error.message,
          });
      }
    });
    app.get("/api/learning", async (req, res) => {
      try {
        const { skill, platform, cost } = req.query;
        const query = {};

        // "skill" may be pipe-joined ("JavaScript|Python") from the dashboard,
        // so escape each segment and keep "|" as the alternation separator.
        if (skill)
          query.relatedSkills = {
            $regex: new RegExp(
              skill.split("|").map(escapeRegExp).join("|"),
              "i"
            ),
          };
        if (platform)
          query.platform = { $regex: new RegExp(escapeRegExp(platform), "i") };
        if (cost)
          query.cost = { $regex: new RegExp(escapeRegExp(cost), "i") };

        const resources = await LearningResourcesCollection.find(
          query
        ).toArray();
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

      app.post("/api/cv/analyze", verifyToken, async (req, res) => {
      try {
        const { cvText } = req.body;

        if (!cvText) {
          return res.status(400).json({ message: "CV text required" });
        }

        // Local extraction first — this never depends on any outside service.
        const extracted = extractLocal(cvText);

        // Role prediction from the team's own trained model. Non-fatal:
        // if the ML service is down or slow, the request still succeeds
        // with the keyword roles only.
        let roles = [...extracted.roles];
        try {
          const prediction = await callMLService(cvText);
          if (prediction && prediction.predicted_category) {
            roles = [titleCaseCategory(prediction.predicted_category), ...roles];
          }
        } catch (err) {
          console.error(
            "CV Analyze: ML prediction unavailable, continuing with local extraction:",
            err.message
          );
        }
        // Deduplicate, cap at ~5 roles.
        roles = [...new Set(roles)].slice(0, 5);

        res.status(200).json({
          data: { skills: extracted.skills, tools: extracted.tools, roles },
        });
      } catch (err) {
        console.error("CV Analysis Error:", err);
        res
          .status(500)
          .json({ message: "CV analysis failed", error: err.message });
      }
    });
    // ================= Trained ML model (Linear SVM) ================
    // Forwards CV text to the FastAPI ML service (ml-service/) and
    // returns the predicted job category + top-3. This is an extra
    // signal shown next to the rule-based matcher — the rule-based
    // matching code is untouched. Requires ML_SERVICE_URL env var.
    // The fetch lives in the shared callMLService() helper above; this
    // handler keeps the exact same behavior as before (400 / 503 / 502
    // / 200 shapes).
    app.post("/api/ml/predict", verifyToken, async (req, res) => {
      try {
        const { cvText } = req.body;
        if (!cvText) {
          return res.status(400).json({ message: "CV text required" });
        }
        const mlServiceUrl = process.env.ML_SERVICE_URL;
        if (!mlServiceUrl) {
          return res.status(503).json({
            message:
              "ML service is not configured (set ML_SERVICE_URL). See ml-service/README.md.",
          });
        }
        const prediction = await callMLService(cvText);
        res.status(200).json({ data: prediction });
      } catch (err) {
        if (err.name === "AbortError") {
          return res.status(502).json({
            message:
              "ML service timed out (it may be waking up — please retry in a few seconds)",
          });
        }
        if (err.mlUpstream) {
          return res.status(502).json({
            message: "ML service returned an error",
            error: err.detail || "",
          });
        }
        console.error("ML Service Error:", err);
        res
          .status(502)
          .json({ message: "ML service unreachable", error: err.message });
      }
    });
// ===== Create Resource =====
app.post("/api/learning", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const resource = req.body;
    await LearningResourcesCollection.insertOne(resource);
    res.status(201).json({ message: "Resource added successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to add resource", error: error.message });
  }
});

// ===== Delete Resource =====
app.delete("/api/learning/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const result = await LearningResourcesCollection.deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Resource not found" });
    res.status(200).json({ message: "Resource deleted successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete resource", error: error.message });
  }
});

// ===== Update Resource (Optional) =====
app.patch("/api/learning/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const updates = req.body;
    const result = await LearningResourcesCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updates }
    );
    if (result.matchedCount === 0) return res.status(404).json({ message: "Resource not found" });
    res.status(200).json({ message: "Resource updated successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to update resource", error: error.message });
  }
});
// GET /api/admin/analytics
app.get("/api/admin/analytics", verifyToken, async (req, res) => {
  try {
    // Only admins can access
    const user = await UsersCollection.findOne({ email: req.user.email });
    if (!user || user.role !== "admin")
      return res.status(403).json({ message: "Forbidden: Admins only" });

    // Number of users analyzed (users who have CV analysis)
    const usersAnalyzed = await UsersCollection.countDocuments({
      cvAnalysis: { $exists: true },
    });

    // Total number of jobs suggested (for simplicity, total jobs in DB)
    const jobsSuggested = await JobsCollection.countDocuments();

    // Most in-demand skills (top skills across all users)
    const allUsers = await UsersCollection.find().toArray();
    const skillCount = {};
    allUsers.forEach(u => {
      (u.skills || []).forEach(skill => {
        skillCount[skill] = (skillCount[skill] || 0) + 1;
      });
    });
    const mostInDemandSkills = Object.entries(skillCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5) // top 5 skills
      .map(([skill, count]) => ({ skill, count }));

    // Common gaps (skills missing in users compared to jobs)
    const allJobs = await JobsCollection.find().toArray();
    const requiredSkills = new Set();
    allJobs.forEach(job => {
      (job.skills || []).forEach(skill => requiredSkills.add(skill));
    });

    const userSkillsSet = new Set();
    allUsers.forEach(u => {
      (u.skills || []).forEach(skill => userSkillsSet.add(skill));
    });

    const commonGaps = [...requiredSkills].filter(skill => !userSkillsSet.has(skill));

    res.status(200).json({
      usersAnalyzed,
      jobsSuggested,
      mostInDemandSkills,
      commonGaps,
    });
  } catch (err) {
    console.error("Admin Analytics Error:", err);
    res.status(500).json({ message: "Failed to fetch analytics", error: err.message });
  }
});

  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch((err) => console.error("Server startup failed:", err));

//For knowing that server is working or not
app.get("/", (req, res) => {
  res.send("Server is Running....");
});

//For knowing which port we are use
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
