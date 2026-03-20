import L from "leaflet";
import {
  projectPatternOnPointPath,
  parseRelativeOrAbsoluteValue,
  pointsToSegments,
  getVisiblePathDistanceRange,
  padPixelBounds,
} from "./patternUtils.js";
import "./L.Symbol.js";

const isCoord = (c) =>
  c instanceof L.LatLng ||
  (Array.isArray(c) && c.length === 2 && typeof c[0] === "number");

const isCoordArray = (ll) => Array.isArray(ll) && isCoord(ll[0]);

L.PolylineDecorator = L.FeatureGroup.extend({
  options: {
    patterns: [],
    // 性能优化：仅按当前可视区计算符号，避免离屏路径消耗
    viewportOnly: true,
    // 视口额外 padding 比例，减少平移时边缘符号闪烁
    viewportPadding: 0.1,
    // 调试：输出性能统计日志
    debugPerformance: false,
    // 调试：每 N 次 redraw 打印一次
    debugEveryNRedraws: 1,
    // 调试：打印最慢路径 Top N
    debugTopPaths: 3,
  },

  initialize: function (paths, options) {
    L.FeatureGroup.prototype.initialize.call(this);
    L.Util.setOptions(this, options);
    this._map = null;
    this._paths = this._initPaths(paths);
    this._pathBounds = this._initPathBounds();
    this._bounds = this._initBounds();
    this._patterns = this._initPatterns(this.options.patterns);
    this._redrawSeq = 0;
    this._projectedPathCache = {
      zoom: null,
      items: [],
    };
  },

  /**
   * Deals with all the different cases. input can be one of these types:
   * array of LatLng, array of 2-number arrays, Polyline, Polygon,
   * array of one of the previous.
   */
  _initPaths: function (input, isPolygon) {
    if (isCoordArray(input)) {
      // Leaflet Polygons don't need the first point to be repeated, but we do
      const coords = isPolygon ? input.concat([input[0]]) : input;
      return [coords];
    }
    if (input instanceof L.Polyline) {
      // we need some recursivity to support multi-poly*
      return this._initPaths(input.getLatLngs(), input instanceof L.Polygon);
    }
    if (Array.isArray(input)) {
      // flatten everything, we just need coordinate lists to apply patterns
      return input.reduce(
        (flatArray, p) => flatArray.concat(this._initPaths(p, isPolygon)),
        [],
      );
    }
    return [];
  },

  // parse pattern definitions and precompute some values
  _initPatterns: function (patternDefs) {
    return patternDefs.map(this._parsePatternDef);
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  setPatterns: function (patterns) {
    this.options.patterns = patterns;
    this._patterns = this._initPatterns(this.options.patterns);
    this.redraw();
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  setPaths: function (paths) {
    this._paths = this._initPaths(paths);
    this._pathBounds = this._initPathBounds();
    this._bounds = this._initBounds();
    this._projectedPathCache = {
      zoom: null,
      items: [],
    };
    this.redraw();
  },

  // 统一计时入口，优先使用高精度 performance.now
  _now: function () {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  },

  // 是否应在本次 redraw 输出调试日志
  _shouldDebug: function () {
    if (!this.options.debugPerformance) {
      return false;
    }
    const every = this.options.debugEveryNRedraws || 1;
    return this._redrawSeq % every === 0;
  },

  // 输出本次 redraw 的性能分项
  _debugLog: function (perf) {
    if (!this._shouldDebug()) {
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[PolylineDecorator][perf]", {
      redraw: perf.redraw,
      totalMs: Math.round(perf.totalMs * 100) / 100,
      clearMs: Math.round(perf.clearMs * 100) / 100,
      drawMs: Math.round(perf.drawMs * 100) / 100,
      directionMs: Math.round(perf.directionMs * 100) / 100,
      symbolMs: Math.round(perf.symbolMs * 100) / 100,
      addLayerMs: Math.round(perf.addLayerMs * 100) / 100,
      pathsTotal: perf.pathsTotal,
      pathsVisible: perf.pathsVisible,
      pathsSkippedByBounds: perf.pathsSkippedByBounds,
      directionPoints: perf.directionPoints,
      symbolsBuilt: perf.symbolsBuilt,
      projectionCacheHits: perf.projectionCacheHits,
      projectionCacheMisses: perf.projectionCacheMisses,
      slowestPaths: perf.slowestPaths,
    });
  },

  // 维护最慢路径列表（按 totalMs 降序）
  _rememberSlowPath: function (perf, pathPerf) {
    if (!this.options.debugPerformance) {
      return;
    }
    perf.slowestPaths.push(pathPerf);
    perf.slowestPaths.sort((a, b) => b.totalMs - a.totalMs);
    const topN = this.options.debugTopPaths || 3;
    if (perf.slowestPaths.length > topN) {
      perf.slowestPaths.length = topN;
    }
  },

  /**
   * Parse the pattern definition
   */
  _parsePatternDef: function (patternDef, latLngs) {
    return {
      symbolFactory: patternDef.symbol,
      // Parse offset and repeat values, managing the two cases:
      // absolute (in pixels) or relative (in percentage of the polyline length)
      offset: parseRelativeOrAbsoluteValue(patternDef.offset),
      endOffset: parseRelativeOrAbsoluteValue(patternDef.endOffset),
      repeat: parseRelativeOrAbsoluteValue(patternDef.repeat),
      lineOffset: patternDef.lineOffset,
    };
  },

  onAdd: function (map) {
    this._map = map;
    this._draw();
    this._map.on("moveend", this.redraw, this);
  },

  onRemove: function (map) {
    this._map.off("moveend", this.redraw, this);
    this._map = null;
    L.FeatureGroup.prototype.onRemove.call(this, map);
  },

  /**
   * As real pattern bounds depends on map zoom and bounds,
   * we just compute the total bounds of all paths decorated by this instance.
   */
  _initBounds: function () {
    const allPathCoords = this._paths.reduce(
      (acc, path) => acc.concat(path),
      [],
    );
    return L.latLngBounds(allPathCoords);
  },

  // 为每条路径预计算地理边界，用于后续快速可视性过滤
  _initPathBounds: function () {
    return this._paths.map((path) => L.latLngBounds(path));
  },

  // 获取路径投影缓存（按 zoom 维度），减少重复 project 与分段计算
  _getProjectedPathData: function (pathIndex, latLngs, perf) {
    const zoom = this._map.getZoom();
    if (this._projectedPathCache.zoom !== zoom) {
      this._projectedPathCache.zoom = zoom;
      this._projectedPathCache.items = [];
    }

    const cached = this._projectedPathCache.items[pathIndex];
    if (cached) {
      perf.projectionCacheHits += 1;
      return cached;
    }

    perf.projectionCacheMisses += 1;
    const pathAsPoints = latLngs.map((latLng) => this._map.project(latLng));
    const data = {
      points: pathAsPoints,
      segments: pointsToSegments(pathAsPoints),
    };
    this._projectedPathCache.items[pathIndex] = data;
    return data;
  },

  getBounds: function () {
    return this._bounds;
  },

  /**
   * Returns an array of ILayers object
   */
  _buildSymbols: function (latLngs, symbolFactory, directionPoints) {
    return directionPoints.map((directionPoint, i) =>
      symbolFactory.buildSymbol(
        directionPoint,
        latLngs,
        this._map,
        i,
        directionPoints.length,
      ),
    );
  },

  /**
   * Compute pairs of LatLng and heading angle,
   * that define positions and directions of the symbols on the path
   */
  _getDirectionPoints: function (latLngs, pattern, pathIndex, perf) {
    if (latLngs.length < 2) {
      return [];
    }

    const projectedPath = this._getProjectedPathData(pathIndex, latLngs, perf);
    const { segments } = projectedPath;

    let range = null;
    if (this.options.viewportOnly) {
      // 仅计算可视区（含 padding）对应的路径距离范围
      const pixelBounds = padPixelBounds(
        L,
        this._map.getPixelBounds(),
        this.options.viewportPadding,
      );
      range = getVisiblePathDistanceRange(segments, pixelBounds);
      if (!range) {
        return [];
      }
    }

    return projectPatternOnPointPath(segments, pattern, range).map((point) => ({
      latLng: this._map.unproject(L.point(point.pt)),
      heading: point.heading,
    }));
  },

  redraw: function () {
    if (!this._map) {
      return;
    }

    // redraw 总耗时 = clearLayers + draw，细分到 perf 便于定位瓶颈
    this._redrawSeq += 1;
    const t0 = this._now();
    this.clearLayers();
    const t1 = this._now();

    const perf = {
      redraw: this._redrawSeq,
      pathsTotal: 0,
      pathsVisible: 0,
      pathsSkippedByBounds: 0,
      directionPoints: 0,
      symbolsBuilt: 0,
      directionMs: 0,
      symbolMs: 0,
      addLayerMs: 0,
      projectionCacheHits: 0,
      projectionCacheMisses: 0,
      slowestPaths: [],
      clearMs: t1 - t0,
      drawMs: 0,
      totalMs: 0,
    };

    const drawStart = this._now();
    this._draw(perf);
    const drawEnd = this._now();

    perf.drawMs = drawEnd - drawStart;
    perf.totalMs = drawEnd - t0;
    this._debugLog(perf);
  },

  /**
   * Returns all symbols for a given pattern as an array of FeatureGroup
   */
  _getPatternLayers: function (pattern, perf) {
    const mapBounds = this._map
      .getBounds()
      .pad(this.options.viewportPadding || 0.1);
    const layers = [];

    this._paths.forEach((path, pathIndex) => {
      perf.pathsTotal += 1;

      // 先做路径级 bounds 粗过滤，离屏路径直接跳过
      const pathBounds = this._pathBounds && this._pathBounds[pathIndex];
      if (pathBounds && !mapBounds.intersects(pathBounds)) {
        perf.pathsSkippedByBounds += 1;
        return;
      }

      perf.pathsVisible += 1;
      const pathPerf = {
        pathIndex,
        pointCount: path.length,
        directionPoints: 0,
        directionMs: 0,
        symbolMs: 0,
        totalMs: 0,
      };

      const directionStart = this._now();
      const directionPoints = this._getDirectionPoints(
        path,
        pattern,
        pathIndex,
        perf,
      )
        // 点级过滤，确保最终仅保留可视点
        .filter((point) => mapBounds.contains(point.latLng));
      const directionEnd = this._now();

      pathPerf.directionPoints = directionPoints.length;
      pathPerf.directionMs = directionEnd - directionStart;
      perf.directionMs += pathPerf.directionMs;
      perf.directionPoints += directionPoints.length;
      perf.symbolsBuilt += directionPoints.length;

      const symbolStart = this._now();
      const symbolLayer = L.featureGroup(
        this._buildSymbols(path, pattern.symbolFactory, directionPoints),
      );
      const symbolEnd = this._now();

      pathPerf.symbolMs = symbolEnd - symbolStart;
      pathPerf.totalMs = pathPerf.directionMs + pathPerf.symbolMs;
      perf.symbolMs += pathPerf.symbolMs;
      this._rememberSlowPath(perf, {
        pathIndex: pathPerf.pathIndex,
        pointCount: pathPerf.pointCount,
        directionPoints: pathPerf.directionPoints,
        directionMs: Math.round(pathPerf.directionMs * 100) / 100,
        symbolMs: Math.round(pathPerf.symbolMs * 100) / 100,
        totalMs: Math.round(pathPerf.totalMs * 100) / 100,
      });

      layers.push(symbolLayer);
    });

    return layers;
  },

  /**
   * Draw all patterns
   */
  _draw: function (perf) {
    const localPerf = perf || {
      redraw: this._redrawSeq,
      pathsTotal: 0,
      pathsVisible: 0,
      pathsSkippedByBounds: 0,
      directionPoints: 0,
      symbolsBuilt: 0,
      directionMs: 0,
      symbolMs: 0,
      addLayerMs: 0,
      projectionCacheHits: 0,
      projectionCacheMisses: 0,
      slowestPaths: [],
      clearMs: 0,
      drawMs: 0,
      totalMs: 0,
    };

    this._patterns
      .map((pattern) => this._getPatternLayers(pattern, localPerf))
      .forEach((layers) => {
        const addLayerStart = this._now();
        this.addLayer(L.featureGroup(layers));
        localPerf.addLayerMs += this._now() - addLayerStart;
      });
  },
});
/*
 * Allows compact syntax to be used
 */
L.polylineDecorator = function (paths, options) {
  return new L.PolylineDecorator(paths, options);
};
