/**
 * 文献路由（§8.2）：只做「参数校验 + 调服务 + 序列化」，不写 SQL、不写业务判断。
 */
import { Router } from 'express';
import { listWorks, listSections, getWorkDetail, patchWork, lookupWorkByIdentifiers } from '../services/artworks.js';
import { buildDoiJumpUrl } from '../services/resolvers/doi.js';
import { AppError } from '../errors.js';
import { parseInput, WORK_NO_PATTERN } from '../middleware/validate.js';
import { WORK_TYPES } from '../services/importer.js';

const LIST_QUERY = {
  q: { type: 'string', maxLength: 200 },
  sectionNo: { type: 'int', min: 0 },
  type: { type: 'enum', enum: WORK_TYPES },
  yearFrom: { type: 'int', min: 1000, max: 2999 },
  yearTo: { type: 'int', min: 1000, max: 2999 },
  hasPdf: { type: 'bool' },
  hasArxiv: { type: 'bool' },
  translateState: { type: 'enum', enum: ['none', 'partial', 'full'] },
  sort: { type: 'enum', enum: ['no', 'year', 'title', 'updated'] },
  order: { type: 'enum', enum: ['asc', 'desc'] },
  page: { type: 'int', min: 1, max: 100000, default: 1 },
  pageSize: { type: 'int', min: 1, max: 200, default: 50 },
};

export function worksRoutes() {
  const r = Router();

  r.get('/sections', (req, res) => {
    res.json(listSections());
  });

  r.get('/works', (req, res, next) => {
    try {
      const p = parseInput(LIST_QUERY, req.query);
      res.json(listWorks(p));
    } catch (e) {
      next(e);
    }
  });

  // ── 标识符精确查找（浏览器直传脚本用；必须在 /works/:no 之前注册）──
  r.get('/works/lookup', (req, res, next) => {
    try {
      const one = (v) => (Array.isArray(v) ? v[0] : v);
      const doi = one(req.query.doi);
      const arxiv = one(req.query.arxiv);
      for (const [k, v] of [['doi', doi], ['arxiv', arxiv]]) {
        if (v !== undefined && (typeof v !== 'string' || v.length > 200)) {
          throw new AppError('E_BAD_REQUEST', `${k} 参数不合法`, { field: k });
        }
      }
      res.json(lookupWorkByIdentifiers({ doi, arxiv }));
    } catch (e) {
      next(e);
    }
  });

  r.get('/works/:no', (req, res, next) => {
    try {
      assertNo(req.params.no);
      res.json(getWorkDetail(req.params.no));
    } catch (e) {
      next(e);
    }
  });

  r.patch('/works/:no', (req, res, next) => {
    try {
      assertNo(req.params.no);
      const allowed = ['title', 'authors', 'year', 'venue', 'type', 'note', 'arxivId', 'doi', 'isbn', 'link', 'sourceNote'];
      const body = req.body || {};
      const known = new Set([...allowed, 'unlock', 'lock', 'lockAll']);
      const unknown = Object.keys(body).filter((k) => !known.has(k));
      if (unknown.length) {
        throw new AppError('E_BAD_REQUEST', `不支持的字段：${unknown.join(', ')}`, { fields: unknown });
      }
      res.json(patchWork(req.params.no, body));
    } catch (e) {
      next(e);
    }
  });

  r.get('/works/:no/doi-jump', (req, res, next) => {
    try {
      assertNo(req.params.no);
      const detail = getWorkDetail(req.params.no);
      const url = buildDoiJumpUrl(detail.work);
      if (!url) throw new AppError('E_NOT_FOUND', '该条目没有 DOI', { no: req.params.no });
      res.json({ doi: detail.work.doi, url });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

function assertNo(no) {
  if (!WORK_NO_PATTERN.test(String(no || ''))) {
    throw new AppError('E_BAD_REQUEST', `编号格式不合法（应为 "段号.序号"）：${no}`, { field: 'no', value: no });
  }
}
