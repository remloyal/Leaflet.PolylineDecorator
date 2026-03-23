import L from "leaflet";
import {
  projectPatternOnPointPath,
  parseRelativeOrAbsoluteValue,
  pointsToSegments,
  getVisiblePathDistanceRange,
  padPixelBounds,
} from "./patternUtils.js";
import "./L.Symbol.js";

// 判断输入是否为单个坐标（LatLng 或 [lat,lng]）
const isCoord = (c) =>
  c instanceof L.LatLng ||
  (Array.isArray(c) && c.length === 2 && typeof c[0] === "number");

// 判断输入是否为坐标数组
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
    // 性能优化：路径完整可见且 zoom 不变时复用上一帧符号
    reuseFullyVisibleAtSameZoom: true,
    // 性能优化：是否分帧异步绘制（降低主线程长任务）
    asyncDraw: false,
    // 性能优化：首次加入地图时是否强制异步分帧绘制
    asyncInitialDraw: true,
    // 每帧最多处理的 path 数（越小越流畅，越大越快完成）
    asyncChunkSize: 60,
  },

  // 构造装饰器实例并初始化缓存/状态
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
    // 增量渲染状态：每个 pattern 对应一个容器组 + 每条 path 的签名与图层
    this._patternGroups = [];
    this._patternLayerState = [];
    // 异步绘制任务序号：每次 redraw 自增，用于取消旧任务
    this._drawTaskId = 0;
    // 异步绘制的 requestAnimFrame 句柄
    this._drawFrame = null;
    // 是否已完成过至少一次绘制（用于首绘策略）
    this._hasDrawnOnce = false;
  },

  // 取消当前异步分帧绘制（在新 redraw 或移除图层时调用）
  _cancelAsyncDraw: function () {
    this._drawTaskId += 1;
    if (this._drawFrame && L.Util.cancelAnimFrame) {
      L.Util.cancelAnimFrame(this._drawFrame);
    }
    this._drawFrame = null;
  },

  /**
   * Deals with all the different cases. input can be one of these types:
   * array of LatLng, array of 2-number arrays, Polyline, Polygon,
   * array of one of the previous.
   */
  // 归一化输入路径：统一转成“坐标数组列表”
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

  // 解析所有 pattern 配置并做预处理
  _initPatterns: function (patternDefs) {
    return patternDefs.map(this._parsePatternDef);
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  // 更新 pattern 配置并触发重绘
  setPatterns: function (patterns) {
    this.options.patterns = patterns;
    this._patterns = this._initPatterns(this.options.patterns);
    this._resetPatternGroups();
    this.redraw();
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  // 更新路径数据并刷新相关缓存后重绘
  setPaths: function (paths) {
    this._paths = this._initPaths(paths);
    this._pathBounds = this._initPathBounds();
    this._bounds = this._initBounds();
    this._projectedPathCache = {
      zoom: null,
      items: [],
    };
    this._clearPatternLayerState();
    this.redraw();
  },

  // 重置每个 pattern 的容器组（用于 setPatterns 后结构变化）
  _resetPatternGroups: function () {
    this.clearLayers();
    this._patternGroups = this._patterns.map(() => L.featureGroup());
    this._patternLayerState = this._patterns.map(() => []);
    this._patternGroups.forEach((group) => this.addLayer(group));
  },

  // 仅清理 path 级缓存状态，保留 pattern 容器结构（用于 setPaths）
  _clearPatternLayerState: function () {
    this._patternGroups.forEach((group) => group.clearLayers());
    this._patternLayerState = this._patterns.map(() => []);
  },

  // 确保 pattern 容器组已创建并与当前 pattern 数量一致
  _ensurePatternGroups: function () {
    if (this._patternGroups.length !== this._patterns.length) {
      this._resetPatternGroups();
    }
  },

  // 计算方向点签名：用于判断某条 path 的符号是否真的变化
  _getDirectionPointsSignature: function (directionPoints) {
    if (!directionPoints.length) {
      return "";
    }
    // 轻量哈希，避免大字符串拼接带来的 GC 压力
    let hash = 2166136261;
    directionPoints.forEach((point) => {
      const { lat, lng } = point.latLng;
      const a = Math.round(lat * 1e6);
      const b = Math.round(lng * 1e6);
      const c = Math.round(point.heading * 1e3);
      hash ^= a;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash ^= b;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash ^= c;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    });
    return `${directionPoints.length}:${hash >>> 0}`;
  },

  // 统一计时入口，优先使用高精度 performance.now
  _now: function () {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  },

  // 判断当前 redraw 是否需要输出调试日志
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
      // 绘制模式：sync=同步一次完成，async=分帧完成
      mode: perf.mode,
      // 总墙钟耗时（async 模式下包含帧间等待）
      totalMs: Math.round(perf.totalMs * 100) / 100,
      // 实际活跃计算耗时（更接近 CPU 真正绘制成本）
      activeMs: Math.round((perf.activeMs || 0) * 100) / 100,
      // 空闲/等待耗时（主要来自 requestAnimationFrame 帧间隔）
      idleMs: Math.round(((perf.totalMs || 0) - (perf.activeMs || 0)) * 100) / 100,
      // 异步模式下总帧数
      asyncFrames: perf.asyncFrames || 0,
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
  // 解析单个 pattern 配置：将 offset/repeat 等值标准化
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

  // 图层加入地图时：初始化绘制并绑定地图事件
  onAdd: function (map) {
    this._map = map;
    this._ensurePatternGroups();
    this._map.on("moveend", this.redraw, this);
    // 首次绘制走 redraw 流程，便于复用 asyncInitialDraw/asyncDraw 策略
    this.redraw();
  },

  // 图层移除时：取消异步任务并解绑事件
  onRemove: function (map) {
    this._cancelAsyncDraw();
    this._map.off("moveend", this.redraw, this);
    this._map = null;
    L.FeatureGroup.prototype.onRemove.call(this, map);
  },

  /**
   * As real pattern bounds depends on map zoom and bounds,
   * we just compute the total bounds of all paths decorated by this instance.
   */
  // 计算全部路径的整体地理边界（对外 getBounds 使用）
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

  // 返回装饰器整体边界
  getBounds: function () {
    return this._bounds;
  },

  /**
   * Returns an array of ILayers object
   */
  // 根据方向点批量构建符号图层
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
  // 计算某条路径上符号应放置的方向点（位置 + 朝向）
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

  // 触发重绘：根据配置选择同步绘制或异步分帧绘制
  redraw: function () {
    if (!this._map) {
      return;
    }

    this._cancelAsyncDraw();

    // redraw 总耗时 = 增量更新 draw（不再全量 clear）
    this._redrawSeq += 1;
    const t0 = this._now();
    const t1 = t0;

    const useAsync = this.options.asyncDraw || (!this._hasDrawnOnce && this.options.asyncInitialDraw);

    const perf = {
      redraw: this._redrawSeq,
      // 当前 redraw 的绘制模式
      mode: useAsync ? "async" : "sync",
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
      // 活跃计算耗时：sync=drawMs，async=各帧处理时间之和
      activeMs: 0,
      // 参与本次 redraw 的帧数（sync 固定为 1）
      asyncFrames: 0,
      totalMs: 0,
    };

    if (useAsync) {
      this._drawAsync(perf, t0);
      return;
    }

    const drawStart = this._now();
    this._draw(perf);
    const drawEnd = this._now();

    perf.drawMs = drawEnd - drawStart;
    perf.activeMs = perf.drawMs;
    perf.asyncFrames = 1;
    perf.totalMs = drawEnd - t0;
    this._debugLog(perf);
    this._hasDrawnOnce = true;
  },

  // 更新单条路径在某个 pattern 下的符号图层（增量复用/重建）
  _updateSinglePath: function (
    pattern,
    patternIndex,
    pathIndex,
    paddedMapBounds,
    visibleMapBounds,
    zoom,
    perf,
  ) {
    // 单条路径更新：用于同步整批更新，也用于异步分块更新
    const patternGroup = this._patternGroups[patternIndex];
    const layerState = this._patternLayerState[patternIndex];
    const path = this._paths[pathIndex];

    perf.pathsTotal += 1;

    const prevState = layerState[pathIndex];

    // 先做路径级 bounds 粗过滤，离屏路径直接跳过
    const pathBounds = this._pathBounds && this._pathBounds[pathIndex];
    if (pathBounds && !paddedMapBounds.intersects(pathBounds)) {
      perf.pathsSkippedByBounds += 1;
      if (prevState && prevState.layer) {
        patternGroup.removeLayer(prevState.layer);
      }
      layerState[pathIndex] = {
        signature: "",
        layer: null,
        zoom,
        fullyVisible: false,
        directionPointsCount: 0,
      };
      return;
    }

    const isFullyVisible = !!(pathBounds && visibleMapBounds.contains(pathBounds));

    if (
      this.options.viewportOnly &&
      this.options.reuseFullyVisibleAtSameZoom &&
      prevState &&
      prevState.layer &&
      prevState.zoom === zoom &&
      prevState.fullyVisible &&
      isFullyVisible
    ) {
      perf.pathsVisible += 1;
      perf.directionPoints += prevState.directionPointsCount || 0;
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
    const directionPoints = this._getDirectionPoints(path, pattern, pathIndex, perf)
      // 点级过滤，确保最终仅保留可视点
      .filter((point) => visibleMapBounds.contains(point.latLng));
    const directionEnd = this._now();

    pathPerf.directionPoints = directionPoints.length;
    pathPerf.directionMs = directionEnd - directionStart;
    perf.directionMs += pathPerf.directionMs;
    perf.directionPoints += directionPoints.length;

    const signature = this._getDirectionPointsSignature(directionPoints);
    if (prevState && prevState.signature === signature) {
      layerState[pathIndex] = {
        signature,
        layer: prevState.layer,
        zoom,
        fullyVisible: isFullyVisible,
        directionPointsCount: directionPoints.length,
      };
      pathPerf.totalMs = pathPerf.directionMs;
      this._rememberSlowPath(perf, {
        pathIndex: pathPerf.pathIndex,
        pointCount: pathPerf.pointCount,
        directionPoints: pathPerf.directionPoints,
        directionMs: Math.round(pathPerf.directionMs * 100) / 100,
        symbolMs: 0,
        totalMs: Math.round(pathPerf.totalMs * 100) / 100,
      });
      return;
    }

    const symbolStart = this._now();
    if (prevState && prevState.layer) {
      patternGroup.removeLayer(prevState.layer);
    }

    let symbolLayer = null;
    if (directionPoints.length > 0) {
      perf.symbolsBuilt += directionPoints.length;
      symbolLayer = L.featureGroup(
        this._buildSymbols(path, pattern.symbolFactory, directionPoints),
      );
      patternGroup.addLayer(symbolLayer);
    }

    layerState[pathIndex] = {
      signature,
      layer: symbolLayer,
      zoom,
      fullyVisible: isFullyVisible,
      directionPointsCount: directionPoints.length,
    };
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
  },

  // 清理多余状态项：当路径数量减少时移除尾部残留图层
  _trimPatternLayerState: function (patternIndex) {
    const patternGroup = this._patternGroups[patternIndex];
    const layerState = this._patternLayerState[patternIndex];
    for (let i = this._paths.length; i < layerState.length; i += 1) {
      if (layerState[i] && layerState[i].layer) {
        patternGroup.removeLayer(layerState[i].layer);
      }
    }
    layerState.length = this._paths.length;
  },

  /**
   * 增量更新某个 pattern 下所有 path 对应的符号图层
   */
  _updatePatternLayers: function (pattern, patternIndex, perf) {
    const visibleMapBounds = this._map.getBounds();
    const paddedMapBounds = visibleMapBounds.pad(
      this.options.viewportPadding || 0.1,
    );
    const zoom = this._map.getZoom();
    for (let pathIndex = 0; pathIndex < this._paths.length; pathIndex += 1) {
      this._updateSinglePath(
        pattern,
        patternIndex,
        pathIndex,
        paddedMapBounds,
        visibleMapBounds,
        zoom,
        perf,
      );
    }
    this._trimPatternLayerState(patternIndex);
  },

  // 异步分帧绘制入口：分块处理路径并在最后汇总性能数据
  _drawAsync: function (perf, t0) {
    // 异步分帧绘制：降低单帧阻塞，提升拖动/缩放流畅度
    this._ensurePatternGroups();

    const localPerf = perf || {
      redraw: this._redrawSeq,
      mode: "async",
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
      activeMs: 0,
      asyncFrames: 0,
      totalMs: 0,
    };

    const visibleMapBounds = this._map.getBounds();
    const paddedMapBounds = visibleMapBounds.pad(
      this.options.viewportPadding || 0.1,
    );
    const zoom = this._map.getZoom();
    const chunkSize = Math.max(1, this.options.asyncChunkSize || 60);
    const drawStart = this._now();

    const taskId = this._drawTaskId;
    // 采用 (patternIndex, pathIndex) 双指针跨帧推进
    let patternIndex = 0;
    let pathIndex = 0;

    const step = () => {
      if (!this._map || taskId !== this._drawTaskId) {
        // 组件已移除或被新任务取代：中止当前任务
        return;
      }

      localPerf.asyncFrames += 1;
      const frameStart = this._now();
      let processed = 0;
      // 每帧最多处理 chunkSize 条 path，避免长任务卡住主线程
      while (patternIndex < this._patterns.length && processed < chunkSize) {
        const start = this._now();
        const pattern = this._patterns[patternIndex];
        this._updateSinglePath(
          pattern,
          patternIndex,
          pathIndex,
          paddedMapBounds,
          visibleMapBounds,
          zoom,
          localPerf,
        );
        localPerf.addLayerMs += this._now() - start;

        pathIndex += 1;
        processed += 1;

        if (pathIndex >= this._paths.length) {
          this._trimPatternLayerState(patternIndex);
          patternIndex += 1;
          pathIndex = 0;
        }
      }
      localPerf.activeMs += this._now() - frameStart;

      if (patternIndex < this._patterns.length) {
        // 未完成：下一帧继续
        this._drawFrame = L.Util.requestAnimFrame(step, this);
        return;
      }

      // 完成：输出本次异步绘制性能统计
      this._drawFrame = null;
      const drawEnd = this._now();
      localPerf.drawMs = drawEnd - drawStart;
      localPerf.totalMs = drawEnd - t0;
      this._debugLog(localPerf);
      this._hasDrawnOnce = true;
    };

    this._drawFrame = L.Util.requestAnimFrame(step, this);
  },

  /**
   * Draw all patterns
   */
  // 同步绘制入口：一次性遍历所有 pattern 与路径
  _draw: function (perf) {
    this._ensurePatternGroups();

    const localPerf = perf || {
      redraw: this._redrawSeq,
      mode: "sync",
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
      activeMs: 0,
      asyncFrames: 0,
      totalMs: 0,
    };

    this._patterns.forEach((pattern, patternIndex) => {
      const addLayerStart = this._now();
      this._updatePatternLayers(pattern, patternIndex, localPerf);
      localPerf.addLayerMs += this._now() - addLayerStart;
    });
  },
});
/*
 * Allows compact syntax to be used
 */
L.polylineDecorator = function (paths, options) {
  // 工厂方法：创建 PolylineDecorator 实例
  return new L.PolylineDecorator(paths, options);
};
