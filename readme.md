# AI-Powered Job & Learning Recommendation Dashboard

## Project Overview
This project is a dashboard that recommends jobs and learning resources based on a user’s skills and career track. Users can register, log in, view personalized job/resource matches, track their applications, and monitor learning progress. The system provides transparent, rule-based recommendations for jobs and learning resources.

## Tech Stack
- **Frontend:** React, Tailwind CSS, React Router
- **Backend:** Node.js, Express
- **Database:** MongoDB
- **Authentication:** JWT, bcrypt
- **API Requests:** Axios
- **Other Libraries:** Cookie-parser, CORS

## Features
- User registration and login with JWT-based authentication.
- Profile management (skills, experience, career track, preferences).
- Dashboard displaying:
  - Personalized recommended jobs
  - Recommended learning resources
  - Active applications
  - Learning progress
- Searchable, filterable, and interactive lists.
- Rule-based recommendation engine (non-AI):
  - Matches jobs/resources based on overlapping skills and career track.
  - Shows why a job/resource is recommended (e.g., “Matches: JavaScript, HTML”).

## Setup Instructions

### Backend Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/Ahammad204/JoblensServer.git
   cd JoblensServer
````

2. Install dependencies:

   ```bash
   npm install
   ```
3. Create a `.env` file in the backend folder and add:

   ```env
   PORT=5000
   MONGODB=<your-mongodb-connection-string>
   JWT_SECRET=<your-jwt-secret>
   ```
4. Seed initial data (optional but recommended for testing):

   * **Seed Jobs:**

     ```bash
     POST http://localhost:5000/api/jobs/seed
     ```
   * **Seed Learning Resources:**

     ```bash
     POST http://localhost:5000/api/learning/seed
     ```
5. Run the backend server:

   ```bash
   npm run dev
   ```
6. Backend will run on `http://localhost:5000`.

### Frontend Setup

1. Navigate to the frontend folder:

   ```bash
   cd ../frontend
   ```
2. Install dependencies:

   ```bash
   npm install
   ```
3. Run the frontend:

   ```bash
   npm run dev
   ```
4. Frontend runs by default on `http://localhost:5173`.

## Environment Configuration Notes

* Ensure Axios calls in the frontend point to the correct backend URL (`http://localhost:5000` for local development).
* Cookies are set as `httpOnly` and `sameSite: 'none'` for cross-origin support; ensure frontend and backend run on compatible domains/ports.
* JWT secret should be a strong, unique string to secure authentication.

## Seed Data Usage

* **Jobs:** Use `/api/jobs/seed` to populate the database with sample jobs.
* **Learning Resources:** Use `/api/learning/seed` to populate sample learning resources.
* These seed endpoints are for development/testing and should not be used in production.

## Recommendation Logic

* Non-AI, rule-based matching.
* **Jobs:** Recommended if a job shares at least one skill with the user’s profile and optionally matches the selected career track.
* **Learning Resources:** Recommended if a resource teaches a skill that the user has or wants to learn.
* Recommendations include a transparent explanation, e.g., “Matches: React, HTML, CSS.”
* Users can filter/search recommendations by skill, platform, or cost.

## API Endpoints

### Authentication

* `POST /api/register` – Register a new user.
* `POST /api/login` – Login user.
* `POST /api/logout` – Logout user.
* `GET /api/me` – Get current logged-in user details.

### Users

* `PATCH /users/:id` – Update user profile (requires JWT).

### Jobs

* `GET /api/jobs` – Get all jobs.
* `GET /api/jobs/:id` – Get job by ID.
* `POST /api/jobs/seed` – Seed sample jobs.
* `POST /api/jobs` – Add a new job (requires JWT).

### Learning Resources

* `GET /api/learning` – Get all learning resources (supports query filters).
* `GET /api/learning/:id` – Get a resource by ID.
* `POST /api/learning/seed` – Seed sample learning resources.

## Folder Structure

```
backend/
  ├─ index.js
  ├─ package.json
  └─ .env
frontend/
  ├─ src/
      ├─ components/
      ├─ pages/
      ├─ App.jsx
      └─ main.jsx
  ├─ package.json
  └─ vite.config.js
```

## Future Enhancements

* AI-based recommendation engine.
* Role-based dashboard customization (admin, mentor, user).
* Notifications for new job/resource matches.
* Analytics for job applications and learning progress.


```
