import { assertProjectValid, type Project } from "./project";

/**
 * 版本化持久化信封。schema/version 双保险，加载时校验 + 迁移。
 */
export const PROJECT_SCHEMA = "cassie/project";
export const PROJECT_VERSION = 1;

export interface ProjectFile {
  schema: typeof PROJECT_SCHEMA;
  version: number;
  savedAt: string;
  project: Project;
}

export function serializeProject(project: Project, savedAt = new Date().toISOString()): ProjectFile {
  assertProjectValid(project);
  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    savedAt,
    // url 是运行时 objectURL，不入盘
    project: stripRuntimeUrls(project),
  };
}

export function projectToJson(project: Project): string {
  return JSON.stringify(serializeProject(project), null, 2);
}

export function parseProjectFile(json: string): Project {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("不是合法的 JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("文件内容为空");
  const file = raw as Partial<ProjectFile>;
  if (file.schema !== PROJECT_SCHEMA) throw new Error(`schema 不匹配: ${String(file.schema)}`);
  const version = typeof file.version === "number" ? file.version : -1;
  if (version < 1 || version > PROJECT_VERSION) {
    throw new Error(`不支持的版本: ${version}（当前支持 1–${PROJECT_VERSION}）`);
  }
  const project = migrate(file.project as Project, version);
  assertProjectValid(project);
  return project;
}

function migrate(project: Project, fromVersion: number): Project {
  // v1 是首个版本；未来版本在此逐级迁移。
  if (fromVersion < PROJECT_VERSION) throw new Error(`缺少 v${fromVersion} → v${PROJECT_VERSION} 迁移`);
  return project;
}

function stripRuntimeUrls(project: Project): Project {
  const { assets, ...rest } = project;
  const cleaned = Object.fromEntries(
    Object.entries(assets).map(([id, asset]) => {
      const { url: _url, ...a } = asset;
      return [id, a];
    }),
  );
  return { ...rest, assets: cleaned };
}

/** 加载后把运行时 objectURL 挂回（由宿主环境提供 url 解析器；解析不到则不写字段） */
export function rehydrateUrls(project: Project, resolveUrl: (assetId: string) => string | undefined): Project {
  for (const asset of Object.values(project.assets)) {
    const url = resolveUrl(asset.id);
    if (url !== undefined) asset.url = url;
  }
  return project;
}
