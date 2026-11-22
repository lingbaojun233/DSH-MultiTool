'use strict';
/**
 * projects.js -- 项目（一个视频主题）与版本（job）的两层结构。
 *
 * 为什么要这一层：同一个主题经常要重做几次（改台词、改画面），
 * 只按 job 平铺的话，重做三次就有三条互不相干的记录，用户找不到"这次是哪个"。
 *
 * 数据模型：
 *   项目   data-v2/projects/<projectId>.json
 *          { id, title, createdAt, updatedAt, nextVersion }
 *   版本   还是原来的 job 记录，只是多两个字段：
 *          job.projectId  属于哪个项目（'' = 未分组旧数据）
 *          job.version    项目内第几版（1 起，创建时分配）
 *
 * 版本的编号在创建时分配（project.nextVersion 自增），不靠 createdAt 排序：
 * 同一毫秒提交两条也不会撞号，删掉中间一版也不会让后面的编号整体前移。
 * 旧 job 没有 version 字段时，读的时候按 createdAt 兜底算一个序号（不落盘）。
 *
 * 这个模块只碰 projects/ 目录和 job 文件里自己的两个字段，不改渲染管线。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureDir, readJson, writeJsonAtomic } = require('./pipeline/cache');

const TITLE_MAX = 60;
const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const UNGROUPED_TITLE = '未分组';

/** 项目 id：短、按时间可排序、不会撞。 */
function newProjectId() {
  return `p${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** 标题收口：去控制字符、压空白、截断。空标题返回 fallback（默认 ''，由展示层补「未命名视频」）。 */
function cleanTitle(raw, fallback) {
  const text = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
  if (text) return text;
  return String(fallback == null ? '' : fallback).trim().slice(0, TITLE_MAX);
}

/**
 * 没给项目标题时从请求里猜一个：分镜首句 > 主题 > 稿子首句 > 兜底。
 * "稿子首句"按中英文句号/问号/感叹号/换行切，避免标题是整段稿子。
 */
function deriveTitle(request) {
  const req = request || {};
  const scenes = Array.isArray(req.scenes) ? req.scenes : [];
  for (const scene of scenes) {
    const text = String((scene && scene.text) || '').trim();
    if (text) return cleanTitle(text);
  }
  const topic = String(req.topic || '').trim();
  if (topic) {
    const firstLine = topic.split(/\n/).map((s) => s.trim()).find(Boolean) || topic;
    return cleanTitle(firstLine);
  }
  const script = String(req.script || '').trim();
  if (script) {
    const first = script.split(/[。！？!?\n\r]/).map((s) => s.trim()).find(Boolean);
    if (first) return cleanTitle(first);
  }
  return '未命名视频';
}

/** job 记录 → 对外摘要（版本行/列表项共用一份字段定义）。 */
function jobSummary(rec, version) {
  const req = rec.request || {};
  const createdAt = Number(rec.createdAt) || 0;
  return {
    jobId: rec.id,
    id: rec.id,
    status: rec.status || 'queued',
    phase: rec.phase || '',
    label: rec.label || '',
    title: rec.title || '',
    projectId: rec.projectId || '',
    projectTitle: rec.projectTitle || '',
    version: Number(version) > 0 ? Number(version) : 0,
    createdAt,
    updatedAt: Number(rec.finishedAt) || createdAt,
    finishedAt: Number(rec.finishedAt) || 0,
    elapsedMs: Number(rec.ms) || 0,
    ms: Number(rec.ms) || 0,
    bytes: Number(rec.bytes) || 0,
    seconds: Number(req.seconds) || 0,
    videoUrl: rec.videoUrl || '',
    srtUrl: rec.srtUrl || '',
    error: rec.error || null,
    redoOf: rec.redoOf || '',
  };
}

class Projects {
  /**
   * @param {object} dirs {projectsDir, jobsDir, outDir, workDir, log}
   */
  constructor(dirs) {
    this.dir = dirs.projectsDir;
    this.jobsDir = dirs.jobsDir;
    this.outDir = dirs.outDir;
    this.workDir = dirs.workDir;
    this.log = typeof dirs.log === 'function' ? dirs.log : () => {};
    ensureDir(this.dir);
  }

  file(id) {
    return path.join(this.dir, `${id}.json`);
  }

  /** 读一个项目；不存在返回 null。 */
  get(id) {
    const key = String(id || '').trim();
    if (!ID_RE.test(key)) return null;
    const rec = readJson(this.file(key), null);
    if (!rec || !rec.id) return null;
    return {
      id: rec.id,
      title: cleanTitle(rec.title),
      createdAt: Number(rec.createdAt) || Date.now(),
      updatedAt: Number(rec.updatedAt) || Number(rec.createdAt) || Date.now(),
      nextVersion: Math.max(1, Number(rec.nextVersion) || 1),
    };
  }

  save(project) {
    const rec = {
      id: project.id,
      title: cleanTitle(project.title),
      createdAt: Number(project.createdAt) || Date.now(),
      updatedAt: Number(project.updatedAt) || Date.now(),
      nextVersion: Math.max(1, Number(project.nextVersion) || 1),
    };
    writeJsonAtomic(this.file(rec.id), rec);
    return rec;
  }

  /** 新建项目；标题空着就用 fallbackTitle，再空就用「未命名视频」。 */
  create(title, fallbackTitle) {
    const now = Date.now();
    const project = {
      id: newProjectId(),
      title: cleanTitle(title, fallbackTitle),
      createdAt: now,
      updatedAt: now,
      nextVersion: 1,
    };
    this.save(project);
    this.log(`新建项目 ${project.id}「${project.title}」`);
    return project;
  }

  /**
   * 把一条 job 挂到项目上：没给 projectId 就新建一个项目。
   * 给了但文件不在（数据被清过/手工拷了 job）时也新建一个同 id 的记录，
   * 保证版本链不断，而不是让这条任务凭空消失。
   */
  attach(job, projectId, request) {
    let pid = String(projectId == null ? '' : projectId).trim();
    // id 会拼进文件路径：只认安全字符，非法的按「没给」处理，避免 ../ 之类写到目录外
    if (pid && !ID_RE.test(pid)) {
      this.log(`非法 projectId「${pid.slice(0, 20)}」，按新建项目处理`);
      pid = '';
    }
    let project = pid ? this.get(pid) : null;
    if (pid && !project) {
      project = {
        id: pid,
        title: cleanTitle('', deriveTitle(request)),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextVersion: 1,
      };
      this.save(project);
      this.log(`项目 ${project.id} 记录缺失，已按标题「${project.title}」补建`);
    }
    if (!project) project = this.create('', deriveTitle(request));

    const version = Math.max(1, project.nextVersion);
    project.nextVersion = version + 1;
    project.updatedAt = Date.now();
    // 空标题的项目在第一次提交时补上主题名（用户建的时候没写标题）
    if (!String(project.title || '').trim()) project.title = cleanTitle('', deriveTitle(request));
    this.save(project);

    job.projectId = project.id;
    job.version = version;
    return { projectId: project.id, version, projectTitle: project.title };
  }

  /** 项目改名。 */
  rename(id, title) {
    const project = this.get(id);
    if (!project) return null;
    project.title = cleanTitle(title, project.title);
    project.updatedAt = Date.now();
    return this.save(project);
  }

  /** 扫全部 job 文件（只读 id 必需的字段，解析整份 JSON）。 */
  readJobs() {
    let files = [];
    try {
      files = fs.readdirSync(this.jobsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const list = [];
    for (const name of files) {
      const rec = readJson(path.join(this.jobsDir, name), null);
      if (!rec || !rec.id) continue;
      list.push(rec);
    }
    return list;
  }

  /**
   * 给一批 job 补上 projectTitle / 版本号。
   * 旧数据没有 version 时按 createdAt 排出的序号兜底（不改盘上记录）。
   */
  annotate(jobs) {
    const projects = new Map();
    for (const project of this.listRaw()) projects.set(project.id, project);

    const byProject = new Map();
    for (const job of jobs) {
      const pid = String(job.projectId || '');
      if (!pid || !projects.has(pid)) continue;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(job);
    }
    for (const [pid, list] of byProject) {
      list.sort((a, b) => (Number(a.createdAt) - Number(b.createdAt))
        || String(a.id).localeCompare(String(b.id)));
      list.forEach((job, index) => {
        if (!(Number(job.version) > 0)) job.version = index + 1;
      });
    }
    for (const job of jobs) {
      const pid = String(job.projectId || '');
      const project = pid ? projects.get(pid) : null;
      job.projectTitle = project ? (project.title || '未命名视频') : (pid ? '' : UNGROUPED_TITLE);
      if (!(Number(job.version) > 0)) job.version = 0;
    }
    return jobs;
  }

  /** 项目文件和 job 记录的原始读取（不排序、不组装 latest）。 */
  listRaw() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const list = [];
    for (const name of files) {
      const rec = readJson(path.join(this.dir, name), null);
      if (!rec || !rec.id) continue;
      list.push({
        id: rec.id,
        title: cleanTitle(rec.title),
        createdAt: Number(rec.createdAt) || 0,
        updatedAt: Number(rec.updatedAt) || Number(rec.createdAt) || 0,
        nextVersion: Math.max(1, Number(rec.nextVersion) || 1),
      });
    }
    return list;
  }

  /** 一个项目下的版本（按版本号升序）。 */
  versionsOf(projectId, jobs) {
    const list = (jobs || this.readJobs()).filter((job) => String(job.projectId || '') === projectId);
    const annotated = this.annotate(list.length ? list : []);
    return annotated.sort((a, b) => (a.version - b.version)
      || (Number(a.createdAt) - Number(b.createdAt)));
  }

  /**
   * 任务页要的列表：每个项目一条摘要 + 未分组的旧任务。
   * latest 取版本号最大的一条（不是 createdAt 最大：删过版本后仍以编号为准）。
   */
  listAll() {
    const jobs = this.readJobs();
    this.annotate(jobs);

    const byProject = new Map();
    const ungrouped = [];
    for (const job of jobs) {
      const pid = String(job.projectId || '');
      if (!pid || !this.get(pid)) {
        ungrouped.push(jobSummary(job, 0));
        continue;
      }
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(job);
    }

    const projects = this.listRaw().map((project) => {
      const list = (byProject.get(project.id) || [])
        .slice()
        .sort((a, b) => (a.version - b.version) || (Number(a.createdAt) - Number(b.createdAt)));
      const latest = list.length ? list[list.length - 1] : null;
      const summary = latest ? jobSummary(latest, latest.version) : null;
      return {
        id: project.id,
        title: project.title || '未命名视频',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        versionCount: list.length,
        latest: summary ? {
          jobId: summary.jobId,
          status: summary.status,
          phase: summary.phase,
          videoUrl: summary.videoUrl,
          seconds: summary.seconds,
          bytes: summary.bytes,
          version: summary.version,
          createdAt: summary.createdAt,
          error: summary.error,
          // 面板靠它区分「重做」和「首次」，缺了会把 v3 重做显示成首次
          redoOf: summary.redoOf,
        } : null,
      };
    });

    projects.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
    ungrouped.sort((a, b) => (b.createdAt - a.createdAt));
    return { projects, ungrouped };
  }

  /** 单个项目的完整版本列表（面板展开时用；旧版在前）。 */
  detail(id) {
    const project = this.get(id);
    if (!project) return null;
    const jobs = this.readJobs();
    this.annotate(jobs);
    const versions = jobs
      .filter((job) => String(job.projectId || '') === project.id)
      .sort((a, b) => (a.version - b.version) || (Number(a.createdAt) - Number(b.createdAt)))
      .map((job) => jobSummary(job, job.version));
    return {
      project: {
        id: project.id,
        title: project.title || '未命名视频',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        versionCount: versions.length,
        latest: versions.length ? versions[versions.length - 1] : null,
      },
      jobs: versions,
    };
  }

  /** 一条 job 关联的文件：job 记录、成片、字幕、渲染工作目录。 */
  jobFiles(jobId) {
    const files = [path.join(this.jobsDir, `${jobId}.json`)];
    const out = ['.mp4', '.srt'];
    for (const ext of out) files.push(path.join(this.outDir, `${jobId}${ext}`));
    return files;
  }

  /**
   * 删项目：先确认没有正在跑/排队的版本（跑到一半删文件只会留半成品），
   * 再按版本逐个删 job 记录 + mp4 + srt + 工作目录，最后删项目文件。
   * 返回删掉了什么，面板/验收据此报告磁盘变化。
   */
  remove(id) {
    const project = this.get(id);
    if (!project) return null;
    const jobs = this.readJobs().filter((job) => String(job.projectId || '') === project.id);
    const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued');
    if (active.length) {
      const err = new Error('PROJECT_BUSY');
      err.code = 'PROJECT_BUSY';
      err.active = active.map((job) => job.id);
      throw err;
    }

    const removed = [];
    let freedBytes = 0;
    for (const job of jobs) {
      for (const file of this.jobFiles(job.id)) {
        try {
          const stat = fs.statSync(file);
          if (stat.isFile()) {
            freedBytes += stat.size;
            fs.unlinkSync(file);
            removed.push(file);
          }
        } catch {
          // 文件本来就不在：不算失败
        }
      }
      const work = path.join(this.workDir, job.id);
      try {
        if (fs.existsSync(work)) {
          freedBytes += this.dirSize(work);
          fs.rmSync(work, { recursive: true, force: true });
          removed.push(work);
        }
      } catch (err) {
        this.log(`删工作目录失败 ${work}: ${String((err && err.message) || err)}`);
      }
    }

    try {
      fs.unlinkSync(this.file(project.id));
      removed.push(this.file(project.id));
    } catch {
      // 项目文件刚好被别人删了：结果一样
    }
    this.log(`删项目 ${project.id}「${project.title}」：${jobs.length} 个版本，释放 ${(freedBytes / 1048576).toFixed(2)}MB`);
    return {
      project: { id: project.id, title: project.title },
      jobIds: jobs.map((job) => job.id),
      removedFiles: removed,
      freedBytes,
    };
  }

  dirSize(dir) {
    let total = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += this.dirSize(full);
      else if (entry.isFile()) {
        try { total += fs.statSync(full).size; } catch { /* 读不到就跳过 */ }
      }
    }
    return total;
  }
}

module.exports = { Projects, deriveTitle, cleanTitle, newProjectId, UNGROUPED_TITLE };
