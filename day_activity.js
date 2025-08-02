const axios = require("axios");
const fs = require("fs");
const dotenv = require("dotenv");
const dayjs = require("dayjs");
const advancedFormat = require("dayjs/plugin/advancedFormat");
const weekday = require("dayjs/plugin/weekday");
const localizedFormat = require("dayjs/plugin/localizedFormat");
const localeData = require("dayjs/plugin/localeData");
const idLocale = require("dayjs/locale/id");

dayjs.extend(advancedFormat);
dayjs.extend(weekday);
dayjs.extend(localizedFormat);
dayjs.extend(localeData);

dayjs.locale("id");

dotenv.config();

const GITLAB_URL = process.env.GITLAB_URL;
const TOKEN = process.env.GITLAB_TOKEN;

const api = axios.create({
  baseURL: `${GITLAB_URL}/api/v4`,
  headers: { "PRIVATE-TOKEN": TOKEN },
});

async function fetchAllPages(url) {
  let page = 1;
  let results = [];
  while (true) {
    const res = await api.get(
      `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (!res.data.length) break;
    results = results.concat(res.data);
    page++;
  }
  return results;
}

async function getCurrentUser() {
  const res = await api.get("/user");
  return res.data;
}

async function getUserProjects() {
  return await fetchAllPages(`/projects?membership=true`);
}

async function getMergeRequests(projectId, userId) {
  const mrs = await fetchAllPages(
    `/projects/${projectId}/merge_requests?author_id=${userId}&scope=all&state=all`,
  );
  return mrs.map((mr) => ({
    iid: mr.iid,
    sha: mr.merge_commit_sha,
    source: mr.source_branch,
    target: mr.target_branch,
    title: mr.title,
    date: mr.created_at,
  }));
}

async function getCommitsFromAllBranches(
  projectId,
  userEmail,
  mergeRequestShas = [],
) {
  const branches = await fetchAllPages(
    `/projects/${projectId}/repository/branches`,
  );
  const seenCommits = new Set();
  const allCommits = [];

  for (const branch of branches) {
    const commits = await fetchAllPages(
      `/projects/${projectId}/repository/commits?ref_name=${branch.name}`,
    );

    for (const commit of commits) {
      if (commit.author_email === userEmail && !seenCommits.has(commit.id)) {
        seenCommits.add(commit.id);

        const fromMR = mergeRequestShas.find((mr) => mr.sha === commit.id);
        allCommits.push({
          type: "Commit",
          branch: branch.name,
          title: commit.title,
          date: commit.created_at,
          from_merge_request: Boolean(fromMR),
          mr_source: fromMR?.source || null,
          mr_target: fromMR?.target || null,
        });
      }
    }
  }

  return allCommits;
}

function saveGroupedToMarkdown(data, filename) {
  const groupedByDay = {};

  data.forEach((item) => {
    const dayKey = dayjs(item.date).format("dddd, D MMMM YYYY");
    if (!groupedByDay[dayKey]) groupedByDay[dayKey] = [];
    groupedByDay[dayKey].push(item);
  });

  const lines = ["# GitLab Activity History\n"];

  for (const [day, activities] of Object.entries(groupedByDay).sort(
    ([a], [b]) => new Date(b) - new Date(a),
  )) {
    lines.push(`\n## 📅 ${day}\n`);

    const commits = activities.filter((a) => a.type === "Commit");
    const mrs = activities.filter((a) => a.type === "Merge Request");

    if (commits.length) {
      lines.push(`### 📝 Commits`);
      for (const c of commits) {
        const fromMR = c.from_merge_request
          ? ` (from MR: \`${c.mr_source} → ${c.mr_target}\`)`
          : "";
        const branch = c.branch || "deleted";
        const project = c.project || "Unknown Project";
        lines.push(`- [\`${project}\`] [\`${branch}\`] ${c.title}${fromMR}`);
      }
      lines.push("");
    }

    if (mrs.length) {
      lines.push(`### 🔀 Merge Requests`);
      for (const mr of mrs) {
        const project = mr.project || "Unknown Project";
        lines.push(
          `- [\`${project}\`] [\`${mr.source} → ${mr.target}\`] ${mr.title}`,
        );
      }
      lines.push("");
    }
  }

  fs.writeFileSync(filename, lines.join("\n"));
  console.log(`✅ Saved ${filename}`);
}

(async () => {
  console.log("📦 Collecting activity across all projects...");

  const user = await getCurrentUser();
  const projects = await getUserProjects();
  const allActivities = [];

  for (const project of projects) {
    const projectId = project.id;
    console.log(`🔍 Processing: ${project.name_with_namespace}`);

    let mergeRequests = [];

    try {
      mergeRequests = await getMergeRequests(projectId, user.id);
      mergeRequests.forEach((mr) => {
        allActivities.push({
          ...mr,
          type: "Merge Request",
          project: project.name_with_namespace,
        });
      });
    } catch (e) {
      console.warn(`❌ Skipped MRs for ${project.name_with_namespace}`);
    }

    try {
      const commits = await getCommitsFromAllBranches(
        projectId,
        user.email,
        mergeRequests,
      );
      commits.forEach((c) => {
        c.project = project.name_with_namespace;
        allActivities.push(c);
      });
    } catch (e) {
      console.warn(`❌ Skipped commits for ${project.name_with_namespace}`);
    }
  }

  saveGroupedToMarkdown(allActivities, "daily_activity.md");
})();
