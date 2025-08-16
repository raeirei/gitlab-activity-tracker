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
            `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`
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
        `/projects/${projectId}/merge_requests?author_id=${userId}&scope=all&state=all`
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

// Build a mapping of commit SHA -> original branch name from MR data
function buildCommitToBranchMapping(mergeRequests, projectId) {
    const commitToBranch = new Map();

    for (const mr of mergeRequests) {
        if (mr.sha) {
            commitToBranch.set(mr.sha, {
                source: mr.source,
                target: mr.target,
                isMergeCommit: true
            });
        }
    }

    return commitToBranch;
}

// Get commits from MR and try to associate them with correct branch
async function getCommitsWithCorrectBranch(projectId, userEmail, mergeRequests) {
    const commitToBranch = buildCommitToBranchMapping(mergeRequests, projectId);
    const allCommits = [];
    const seenCommits = new Set();

    // First, get all commits from all MRs to build a more complete mapping
    for (const mr of mergeRequests) {
        try {
            const commits = await fetchAllPages(
                `/projects/${projectId}/merge_requests/${mr.iid}/commits`
            );

            for (const commit of commits) {
                if (commit.author_email === userEmail && !seenCommits.has(commit.id)) {
                    seenCommits.add(commit.id);

                    // Use the source branch from MR as the original branch
                    allCommits.push({
                        type: "Commit",
                        branch: mr.source, // Original source branch
                        target_branch: mr.target,
                        title: commit.title,
                        date: commit.created_at,
                        sha: commit.id,
                        from_merge_request: true,
                        mr_source: mr.source,
                        mr_target: mr.target,
                    });
                }
            }
        } catch (e) {
            console.warn(`❌ Could not fetch commits for MR ${mr.iid}`);
        }
    }

    // Then get remaining commits from existing branches (for non-merged work)
    try {
        const branches = await fetchAllPages(`/projects/${projectId}/repository/branches`);

        for (const branch of branches) {
            const commits = await fetchAllPages(
                `/projects/${projectId}/repository/commits?ref_name=${branch.name}`
            );

            for (const commit of commits) {
                if (commit.author_email === userEmail && !seenCommits.has(commit.id)) {
                    seenCommits.add(commit.id);

                    // Check if this is a merge commit
                    const mergeMatch = commit.title.match(/Merge branch '(.+?)'.*into (.+)/);
                    let displayBranch = branch.name;
                    let targetBranch = null;

                    if (mergeMatch) {
                        displayBranch = mergeMatch[2] || branch.name;
                        targetBranch = mergeMatch[2] || branch.name;
                    }

                    allCommits.push({
                        type: "Commit",
                        branch: displayBranch,
                        target_branch: targetBranch,
                        title: commit.title,
                        date: commit.created_at,
                        sha: commit.id,
                        from_merge_request: false,
                        mr_source: null,
                        mr_target: null,
                    });
                }
            }
        }
    } catch (e) {
        console.warn(`❌ Could not fetch commits from branches`);
    }

    return allCommits;
}

// --- Extract existing SHAs / MRs from markdown ---
function extractExistingIds(filename) {
    const shas = new Set();
    const mrs = new Set();
    if (!fs.existsSync(filename)) return { shas, mrs };

    const content = fs.readFileSync(filename, "utf8");
    const commitShaRegex = /\[([^\]]+)\] \[([^\]]+)\] .*?\(from MR: .*?\)?/g;
    const mrRegex = /\[([^\]]+)\] \[([^\]]+ → [^\]]+)\] .*/g;

    let match;
    while ((match = commitShaRegex.exec(content))) {
        shas.add(match[1]);
    }
    while ((match = mrRegex.exec(content))) {
        mrs.add(match[2]);
    }

    return { shas, mrs };
}

// --- Extract existing data from JSON ---
function extractExistingFromJson(filename) {
    const existing = { shas: new Set(), mrs: new Set(), data: [] };
    if (!fs.existsSync(filename)) return existing;

    try {
        const content = fs.readFileSync(filename, "utf8");
        const jsonData = JSON.parse(content);

        if (jsonData.activities) {
            existing.data = jsonData.activities;
            jsonData.activities.forEach(item => {
                if (item.type === "Commit") {
                    existing.shas.add(item.sha);
                } else if (item.type === "Merge Request") {
                    existing.mrs.add(`${item.source} → ${item.target}`);
                }
            });
        }
    } catch (e) {
        console.warn(`⚠️ Could not parse existing JSON file: ${e.message}`);
    }

    return existing;
}

function saveAsJson(data, filename) {
    const existing = extractExistingFromJson(filename);

    const filteredData = data.filter((item) => {
        if (item.type === "Commit") return !existing.shas.has(item.sha);
        if (item.type === "Merge Request")
            return !existing.mrs.has(`${item.source} → ${item.target}`);
        return true;
    });

    if (!filteredData.length && existing.data.length > 0) {
        console.log("ℹ No new activity to add to JSON.");
        return existing.data;
    }

    // Combine existing and new data, sort by date (newest first)
    const allData = [...existing.data, ...filteredData].sort(
        (a, b) => new Date(b.date) - new Date(a.date)
    );

    const output = {
        generated_at: new Date().toISOString(),
        total_activities: allData.length,
        summary: {
            commits: allData.filter(item => item.type === "Commit").length,
            merge_requests: allData.filter(item => item.type === "Merge Request").length,
        },
        activities: allData
    };

    fs.writeFileSync(filename, JSON.stringify(output, null, 2));
    console.log(`✅ Updated ${filename} (${filteredData.length} new activities)`);

    return allData;
}

function saveGroupedToMarkdown(data, filename) {
    const { shas: existingShas, mrs: existingMRs } = extractExistingIds(filename);

    const filteredData = data.filter((item) => {
        if (item.type === "Commit") return !existingShas.has(item.sha);
        if (item.type === "Merge Request")
            return !existingMRs.has(`${item.source} → ${item.target}`);
        return true;
    });

    if (!filteredData.length) {
        console.log("ℹ No new activity to append to markdown.");
        return;
    }

    const groupedByDay = {};
    filteredData.forEach((item) => {
        const dayKey = dayjs(item.date).format("dddd, D MMMM YYYY");
        if (!groupedByDay[dayKey]) groupedByDay[dayKey] = [];
        groupedByDay[dayKey].push(item);
    });

    let newLines = [];
    for (const [day, activities] of Object.entries(groupedByDay).sort(
        ([a], [b]) => new Date(b) - new Date(a)
    )) {
        newLines.push(`\n## 📅 ${day}\n`);

        const commits = activities.filter((a) => a.type === "Commit");
        const mrs = activities.filter((a) => a.type === "Merge Request");

        if (commits.length) {
            newLines.push(`### 📝 Commits`);
            for (const c of commits) {
                const fromMR = c.from_merge_request
                    ? ` (from MR: \`${c.mr_source} → ${c.mr_target}\`)`
                    : "";
                const branchLabel = `[${c.branch}${c.target_branch ? " / " + c.target_branch : ""}]`;
                const project = c.project || "Unknown Project";
                newLines.push(`- [\`${project}\`] ${branchLabel} ${c.title}${fromMR}`);
            }
            newLines.push("");
        }

        if (mrs.length) {
            newLines.push(`### 🔀 Merge Requests`);
            for (const mr of mrs) {
                const project = mr.project || "Unknown Project";
                newLines.push(
                    `- [\`${project}\`] [${mr.source} → ${mr.target}] ${mr.title}`
                );
            }
            newLines.push("");
        }
    }

    if (fs.existsSync(filename)) {
        const existingContent = fs.readFileSync(filename, "utf8");
        fs.writeFileSync(
            filename,
            `# GitLab Activity History\n${newLines.join("\n")}${existingContent.replace(/^# GitLab Activity History\n/, "")}`
        );
    } else {
        fs.writeFileSync(filename, `# GitLab Activity History\n${newLines.join("\n")}`);
    }

    console.log(`✅ Updated ${filename}`);
}

// --- Main ---
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
            // Use the new function that gets commits with correct branch names
            const commits = await getCommitsWithCorrectBranch(
                projectId,
                user.email,
                mergeRequests
            );
            commits.forEach((c) => {
                c.project = project.name_with_namespace;
                allActivities.push(c);
            });
        } catch (e) {
            console.warn(`❌ Skipped commits for ${project.name_with_namespace}: ${e.message}`);
        }
    }

    // Save in both formats
    const jsonData = saveAsJson(allActivities, "daily_activity.json");
    saveGroupedToMarkdown(allActivities, "daily_activity.md");

    console.log(`\n📊 Summary:`);
    console.log(`   Total activities: ${allActivities.length}`);
    console.log(`   Commits: ${allActivities.filter(a => a.type === "Commit").length}`);
    console.log(`   Merge Requests: ${allActivities.filter(a => a.type === "Merge Request").length}`);
    console.log(`   Projects processed: ${projects.length}`);
})();