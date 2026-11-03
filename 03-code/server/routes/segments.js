/**
 * 抽取与段落路由（§8.4）：
 *  - POST /api/assets/:id/extract        抽取（幂等；force=true 才重抽并 extract_version+1）
 *  - GET  /api/works/:no/segments        按页取段（可带译文命中）
 *  - GET  /api/works/:no/search          段内检索（FTS5 + CJK 2-gram），M3 对话也会用这条
 */
import { Router } from 'express';
import { get } from '../db.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { extractAsset, getSegments, readRuntimeInfo, EXTRACTOR_VERSION } from '../services/extractor.js';
import { searchSegments } from '../services/fts.js';
import { retrieve } from '../services/chat/retrieval.js';
import { getWorkRow } from '../services/artworks.js';
import { buildCacheKey } from '../services/translate/cacheKey.js';
import { promptFingerprint, resolveTemplate } from '../services/translate/prompts.js';
import { resolveModel } from '../services/translate/engines/registry.js';
import { parseInput, WORK_NO_PATTERN } from '../middleware/validate.js';

export function segmentRoutes() {
  const r = Router();

  r.post('/assets/:id/extract', async (req, res, next) => {
    try {
      const assetId = Number(req.params.id);
      if (!Number.isInteger(assetId) || assetId <= 0) {
        throw new AppError('E_BAD_REQUEST', `资产 id 不合法：${req.params.id}`, { field: 'id' });
      }
      const summary = await extractAsset(assetId, { force: req.body && req.body.force === true });
      res.status(summary.reused ? 200 : 200).json(summary);
    } catch (e) {
      next(e);
    }
  });

  r.get('/works/:no/segments', (req, res, next) => {
    try {
      const no = req.params.no;
      if (!WORK_NO_PATTERN.test(String(no || ''))) {
        throw new AppError('E_BAD_REQUEST', `编号格式不合法：${no}`, { field: 'no' });
      }
      const work = getWorkRow(no);
      if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${no}`, { no });
      const asset = get("SELECT * FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
      if (!asset) throw new AppError('E_NOT_FOUND', '该条目还没有本地 PDF', { no });

      const q = parseInput(
        {
          page: { type: 'int', min: 1 },
          from: { type: 'int', min: 1 },
          to: { type: 'int', min: 1 },
          withTranslation: { type: 'bool', default: false },
          engine: { type: 'string', maxLength: 40 },
          tgtLang: { type: 'string', maxLength: 20 },
        },
        req.query,
      );

      let translation = null;
      if (q.withTranslation) {
        const engine = q.engine || config.translate.engine;
        translation = {
          engine,
          model: resolveModel(engine),
          tgtLang: q.tgtLang || config.translate.tgtLang,
          promptFp: promptFingerprint(resolveTemplate(config)),
        };
      }
      const out = getSegments(asset.id, { page: q.page, from: q.from, to: q.to, translation });
      res.json({
        ...out,
        extractStatus: asset.extract_status,
        extractVersion: asset.extract_version,
        // 抽取算法版本的「当前值」也要给前端：库里存的版本更旧时，前端才会主动
        // 触发一次重抽（否则改进了抽取算法也只能靠手工删库生效）。
        extractorVersion: EXTRACTOR_VERSION,
        extractor: readRuntimeInfo(),
        translationQuery: translation,
      });
    } catch (e) {
      next(e);
    }
  });

  r.get('/works/:no/search', async (req, res, next) => {
    try {
      const work = getWorkRow(req.params.no);
      if (!work) throw new AppError('E_NOT_FOUND', `条目不存在：${req.params.no}`);
      const asset = get("SELECT id FROM assets WHERE work_id = ? AND kind = 'pdf'", [work.id]);
      if (!asset) throw new AppError('E_NOT_FOUND', '该条目还没有本地 PDF');
      const q = String(req.query.q || '').trim();
      if (!q) throw new AppError('E_BAD_REQUEST', '缺少查询串 q', { field: 'q' });
      const topK = Math.min(Number(req.query.topK) || 20, 100);
      const allowRewrite = req.query.rewrite !== '0'; // 默认允许跨语言改写兜底
      let degraded = null;
      // 走 retrieval.retrieve：双索引 → 0 命中且含中文 → 廉价档改写成英文关键词重试一次
      const out = await retrieve({ assetId: asset.id, query: q, topK, allowRewrite });
      res.json({
        q,
        assetId: asset.id,
        hits: out.hits.length,
        degraded,
        rewritten: out.rewritten,
        keywords: out.keywords,
        rewriteMocked: out.mocked,
        reason: out.reason,
        results: out.hits,
      });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

export { buildCacheKey };
