/**
 * 适配器注册表（SM-1.1）。
 * 管理已加载的 manifest，支持单个启停；热加载由上层监听目录后调用 register/unregister。
 */
import type { AdapterManifest } from '@awm/schema';

/** 适配器注册表 */
export class AdapterRegistry {
  /** id → manifest */
  private readonly manifests = new Map<string, AdapterManifest>();

  /**
   * 注册一个适配器。
   * @param manifest 已校验的 manifest
   * @throws id 重复时抛出
   */
  register(manifest: AdapterManifest): void {
    if (this.manifests.has(manifest.id)) {
      throw new Error(`适配器 id 重复：${manifest.id}`);
    }
    this.manifests.set(manifest.id, manifest);
  }

  /**
   * 注销一个适配器。
   * @param id 适配器 id
   * @returns 是否成功注销
   */
  unregister(id: string): boolean {
    return this.manifests.delete(id);
  }

  /**
   * 查询适配器。
   * @param id 适配器 id
   * @returns manifest，不存在时返回 undefined
   */
  get(id: string): AdapterManifest | undefined {
    return this.manifests.get(id);
  }

  /**
   * 判断适配器是否已注册。
   * @param id 适配器 id
   * @returns 是否已注册
   */
  has(id: string): boolean {
    return this.manifests.has(id);
  }

  /**
   * 列出全部适配器。
   * @returns manifest 列表
   */
  list(): AdapterManifest[] {
    return [...this.manifests.values()];
  }

  /**
   * 已注册适配器数量。
   * @returns 数量
   */
  get size(): number {
    return this.manifests.size;
  }
}
