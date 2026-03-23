(function (global, factory) {
	typeof exports === 'object' && typeof module !== 'undefined' ? factory(require('leaflet')) :
	typeof define === 'function' && define.amd ? define(['leaflet'], factory) :
	(factory(global.L));
}(this, (function (L$1) { 'use strict';

L$1 = L$1 && L$1.hasOwnProperty('default') ? L$1['default'] : L$1;

// functional re-impl of L.Point.distanceTo,
// with no dependency on Leaflet for easier testing
function pointDistance(ptA, ptB) {
  var x = ptB.x - ptA.x;
  var y = ptB.y - ptA.y;
  return Math.sqrt(x * x + y * y);
}

var computeSegmentHeading = function computeSegmentHeading(a, b) {
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI + 90 + 360) % 360;
};

var asRatioToPathLength = function asRatioToPathLength(_ref, totalPathLength) {
  var value = _ref.value,
      isInPixels = _ref.isInPixels;
  return isInPixels ? value / totalPathLength : value;
};

function parseRelativeOrAbsoluteValue(value) {
  if (typeof value === "string" && value.indexOf("%") !== -1) {
    return {
      value: parseFloat(value) / 100,
      isInPixels: false
    };
  }
  var parsedValue = value ? parseFloat(value) : 0;
  return {
    value: parsedValue,
    isInPixels: parsedValue > 0
  };
}

var pointsEqual = function pointsEqual(a, b) {
  return a.x === b.x && a.y === b.y;
};

/**
 * 计算单条线段在像素边界内对应的路径距离区间。
 *
 * 说明：
 * - 使用 Liang–Barsky 线段裁剪算法得到参数区间 [t0, t1]
 * - 再将参数区间映射到该线段在整条路径上的距离区间 [min, max]
 *
 * @param {{ a:{x:number,y:number}, b:{x:number,y:number}, distA:number, distB:number }} segment
 * @param {{ min:{x:number,y:number}, max:{x:number,y:number} }} bounds
 * @returns {{ min:number, max:number } | null}
 */
function getClippedSegmentDistanceRange(segment, bounds) {
  var dx = segment.b.x - segment.a.x;
  var dy = segment.b.y - segment.a.y;
  var t0 = 0;
  var t1 = 1;

  function clip(p, q) {
    if (p === 0) {
      return q >= 0;
    }

    var ratio = q / p;
    if (p < 0) {
      if (ratio > t1) {
        return false;
      }
      if (ratio > t0) {
        t0 = ratio;
      }
    } else {
      if (ratio < t0) {
        return false;
      }
      if (ratio < t1) {
        t1 = ratio;
      }
    }

    return true;
  }

  if (!clip(-dx, segment.a.x - bounds.min.x) || !clip(dx, bounds.max.x - segment.a.x) || !clip(-dy, segment.a.y - bounds.min.y) || !clip(dy, bounds.max.y - segment.a.y)) {
    return null;
  }

  var segmentLength = segment.distB - segment.distA;
  return {
    min: segment.distA + segmentLength * t0,
    max: segment.distA + segmentLength * t1
  };
}

/**
 * 按比例扩展像素边界。
 *
 * @param {*} L Leaflet 命名空间对象
 * @param {{ min:any, max:any, getSize?:Function }} bounds
 * @param {number} ratio
 * @returns {*} 扩展后的 bounds
 */
function padPixelBounds(L, bounds, ratio) {
  if (!ratio) {
    return bounds;
  }

  var size = bounds.getSize ? bounds.getSize() : { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y };
  var padding = L.point(size.x * ratio, size.y * ratio);
  return L.bounds(bounds.min.subtract(padding), bounds.max.add(padding));
}

/**
 * 计算整条路径在当前像素视口内的可见距离范围。
 *
 * @param {Array<{ a:{x:number,y:number}, b:{x:number,y:number}, distA:number, distB:number }>} segments
 * @param {{ min:{x:number,y:number}, max:{x:number,y:number} }} pixelBounds
 * @returns {{ min:number, max:number } | null}
 */
function getVisiblePathDistanceRange(segments, pixelBounds) {
  if (segments.length === 0) {
    return null;
  }

  var minDist = Infinity;
  var maxDist = -Infinity;
  for (var i = 0; i < segments.length; i++) {
    var clippedRange = getClippedSegmentDistanceRange(segments[i], pixelBounds);
    if (clippedRange) {
      if (clippedRange.min < minDist) {
        minDist = clippedRange.min;
      }
      if (clippedRange.max > maxDist) {
        maxDist = clippedRange.max;
      }
    }
  }

  if (minDist === Infinity) {
    return null;
  }

  return { min: minDist, max: maxDist };
}

function pointsToSegments(pts) {
  return pts.reduce(function (segments, b, idx, points) {
    // this test skips same adjacent points
    if (idx > 0 && !pointsEqual(b, points[idx - 1])) {
      var a = points[idx - 1];
      var distA = segments.length > 0 ? segments[segments.length - 1].distB : 0;
      var distAB = pointDistance(a, b);
      segments.push({
        a: a,
        b: b,
        distA: distA,
        distB: distA + distAB,
        heading: computeSegmentHeading(a, b)
      });
    }
    return segments;
  }, []);
}

function projectPatternOnPointPath(segmentsOrPoints, pattern, range) {
  var hasSegments = Array.isArray(segmentsOrPoints) && segmentsOrPoints.length > 0 && typeof segmentsOrPoints[0].distA === "number" && typeof segmentsOrPoints[0].distB === "number";

  var segments = hasSegments ? segmentsOrPoints : pointsToSegments(segmentsOrPoints);
  var nbSegments = segments.length;
  if (nbSegments === 0) {
    return [];
  }

  var totalPathLength = segments[nbSegments - 1].distB;

  var offset = asRatioToPathLength(pattern.offset, totalPathLength);
  var endOffset = asRatioToPathLength(pattern.endOffset, totalPathLength);
  var repeat = asRatioToPathLength(pattern.repeat, totalPathLength);
  var lineOffset = pattern.lineOffset || 0;

  var repeatIntervalPixels = totalPathLength * repeat;
  var startOffsetPixels = offset > 0 ? totalPathLength * offset : 0;
  var endOffsetPixels = endOffset > 0 ? totalPathLength * endOffset : 0;

  var minOffset = startOffsetPixels;
  var maxOffset = totalPathLength - endOffsetPixels;
  if (range && typeof range.min === "number") {
    minOffset = Math.max(minOffset, range.min);
  }
  if (range && typeof range.max === "number") {
    maxOffset = Math.min(maxOffset, range.max);
  }
  if (maxOffset < minOffset) {
    return [];
  }

  // 2. generate the positions of the pattern as offsets from the path start
  var positionOffsets = [];
  if (repeatIntervalPixels > 0) {
    var n = Math.ceil((minOffset - startOffsetPixels) / repeatIntervalPixels);
    if (n < 0) {
      n = 0;
    }
    var positionOffset = startOffsetPixels + n * repeatIntervalPixels;
    while (positionOffset <= maxOffset) {
      positionOffsets.push(positionOffset);
      positionOffset += repeatIntervalPixels;
    }
  } else if (startOffsetPixels >= minOffset && startOffsetPixels <= maxOffset) {
    positionOffsets.push(startOffsetPixels);
  }

  // 3. projects offsets to segments
  var segmentIndex = 0;
  var segment = segments[0];
  return positionOffsets.map(function (positionOffset) {
    // find the segment matching the offset,
    // starting from the previous one as offsets are ordered
    while (positionOffset > segment.distB && segmentIndex < nbSegments - 1) {
      segmentIndex++;
      segment = segments[segmentIndex];
    }

    var segmentRatio = (positionOffset - segment.distA) / (segment.distB - segment.distA);
    return {
      pt: interpolateBetweenPoints(segment.a, segment.b, segmentRatio, lineOffset, segment.distB - segment.distA),
      heading: segment.heading
    };
  });
}

/**
 * Finds the point which lies on the segment defined by points A and B,
 * at the given ratio of the distance from A to B, by linear interpolation.
 */
function interpolateBetweenPoints(ptA, ptB, ratio) {
  var lineOffset = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : 0;
  var length = arguments.length > 4 && arguments[4] !== undefined ? arguments[4] : 0;

  var n = { x: 0, y: 0 };
  if (lineOffset !== 0 && length > 0) {
    n = { x: -(ptB.y - ptA.y) / length, y: (ptB.x - ptA.x) / length };
  }

  if (ptB.x !== ptA.x) {
    return {
      x: ptA.x + ratio * (ptB.x - ptA.x) + n.x * lineOffset,
      y: ptA.y + ratio * (ptB.y - ptA.y) + n.y * lineOffset
    };
  }
  // special case where points lie on the same vertical axis
  return {
    x: ptA.x + n.x * lineOffset,
    y: ptA.y + (ptB.y - ptA.y) * ratio + n.y * lineOffset
  };
}

(function () {
    // save these original methods before they are overwritten
    var proto_initIcon = L.Marker.prototype._initIcon;
    var proto_setPos = L.Marker.prototype._setPos;

    var oldIE = L.DomUtil.TRANSFORM === 'msTransform';

    L.Marker.addInitHook(function () {
        var iconOptions = this.options.icon && this.options.icon.options;
        var iconAnchor = iconOptions && this.options.icon.options.iconAnchor;
        if (iconAnchor) {
            iconAnchor = iconAnchor[0] + 'px ' + iconAnchor[1] + 'px';
        }
        this.options.rotationOrigin = this.options.rotationOrigin || iconAnchor || 'center bottom';
        this.options.rotationAngle = this.options.rotationAngle || 0;

        // Ensure marker keeps rotated during dragging
        this.on('drag', function (e) {
            e.target._applyRotation();
        });
    });

    L.Marker.include({
        _initIcon: function _initIcon() {
            proto_initIcon.call(this);
        },

        _setPos: function _setPos(pos) {
            proto_setPos.call(this, pos);
            this._applyRotation();
        },

        _applyRotation: function _applyRotation() {
            if (this.options.rotationAngle) {
                this._icon.style[L.DomUtil.TRANSFORM + 'Origin'] = this.options.rotationOrigin;

                if (oldIE) {
                    // for IE 9, use the 2D rotation
                    this._icon.style[L.DomUtil.TRANSFORM] = 'rotate(' + this.options.rotationAngle + 'deg)';
                } else {
                    // for modern browsers, prefer the 3D accelerated version
                    this._icon.style[L.DomUtil.TRANSFORM] += ' rotateZ(' + this.options.rotationAngle + 'deg)';
                }
            }
        },

        setRotationAngle: function setRotationAngle(angle) {
            this.options.rotationAngle = angle;
            this.update();
            return this;
        },

        setRotationOrigin: function setRotationOrigin(origin) {
            this.options.rotationOrigin = origin;
            this.update();
            return this;
        }
    });
})();

// enable rotationAngle and rotationOrigin support on L.Marker
/**
* Defines several classes of symbol factories,
* to be used with L.PolylineDecorator
*/

L$1.Symbol = L$1.Symbol || {};

/**
* A simple dash symbol, drawn as a Polyline.
* Can also be used for dots, if 'pixelSize' option is given the 0 value.
*/
L$1.Symbol.Dash = L$1.Class.extend({
    options: {
        pixelSize: 10,
        pathOptions: {}
    },

    initialize: function initialize(options) {
        L$1.Util.setOptions(this, options);
        this.options.pathOptions.clickable = false;
    },

    buildSymbol: function buildSymbol(dirPoint, latLngs, map, index, total) {
        var opts = this.options;
        var d2r = Math.PI / 180;

        // for a dot, nothing more to compute
        if (opts.pixelSize <= 1) {
            return L$1.polyline([dirPoint.latLng, dirPoint.latLng], opts.pathOptions);
        }

        var midPoint = map.project(dirPoint.latLng);
        var angle = -(dirPoint.heading - 90) * d2r;
        var a = L$1.point(midPoint.x + opts.pixelSize * Math.cos(angle + Math.PI) / 2, midPoint.y + opts.pixelSize * Math.sin(angle) / 2);
        // compute second point by central symmetry to avoid unecessary cos/sin
        var b = midPoint.add(midPoint.subtract(a));
        return L$1.polyline([map.unproject(a), map.unproject(b)], opts.pathOptions);
    }
});

L$1.Symbol.dash = function (options) {
    return new L$1.Symbol.Dash(options);
};

L$1.Symbol.ArrowHead = L$1.Class.extend({
    options: {
        polygon: true,
        pixelSize: 10,
        headAngle: 60,
        angleCorrection: 0,
        pathOptions: {
            stroke: false,
            weight: 2
        }
    },

    initialize: function initialize(options) {
        L$1.Util.setOptions(this, options);
        this.options.pathOptions.clickable = false;
    },

    buildSymbol: function buildSymbol(dirPoint, latLngs, map, index, total) {
        return this.options.polygon ? L$1.polygon(this._buildArrowPath(dirPoint, map), this.options.pathOptions) : L$1.polyline(this._buildArrowPath(dirPoint, map), this.options.pathOptions);
    },

    _buildArrowPath: function _buildArrowPath(dirPoint, map) {
        var d2r = Math.PI / 180;
        var tipPoint = map.project(dirPoint.latLng);
        var direction = -(dirPoint.heading - 90 + this.options.angleCorrection) * d2r;
        var radianArrowAngle = this.options.headAngle / 2 * d2r;

        var headAngle1 = direction + radianArrowAngle;
        var headAngle2 = direction - radianArrowAngle;
        var arrowHead1 = L$1.point(tipPoint.x - this.options.pixelSize * Math.cos(headAngle1), tipPoint.y + this.options.pixelSize * Math.sin(headAngle1));
        var arrowHead2 = L$1.point(tipPoint.x - this.options.pixelSize * Math.cos(headAngle2), tipPoint.y + this.options.pixelSize * Math.sin(headAngle2));

        return [map.unproject(arrowHead1), dirPoint.latLng, map.unproject(arrowHead2)];
    }
});

L$1.Symbol.arrowHead = function (options) {
    return new L$1.Symbol.ArrowHead(options);
};

L$1.Symbol.Marker = L$1.Class.extend({
    options: {
        markerOptions: {},
        rotate: false
    },

    initialize: function initialize(options) {
        L$1.Util.setOptions(this, options);
        this.options.markerOptions.clickable = false;
        this.options.markerOptions.draggable = false;
    },

    buildSymbol: function buildSymbol(directionPoint, latLngs, map, index, total) {
        if (this.options.rotate) {
            this.options.markerOptions.rotationAngle = directionPoint.heading + (this.options.angleCorrection || 0);
        }
        return L$1.marker(directionPoint.latLng, this.options.markerOptions);
    }
});

L$1.Symbol.marker = function (options) {
    return new L$1.Symbol.Marker(options);
};

// 判断输入是否为单个坐标（LatLng 或 [lat,lng]）
var isCoord = function isCoord(c) {
  return c instanceof L$1.LatLng || Array.isArray(c) && c.length === 2 && typeof c[0] === "number";
};

// 判断输入是否为坐标数组
var isCoordArray = function isCoordArray(ll) {
  return Array.isArray(ll) && isCoord(ll[0]);
};

L$1.PolylineDecorator = L$1.FeatureGroup.extend({
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
    // 每帧最多处理的 path 数（越小越流畅，越大越快完成）
    asyncChunkSize: 60
  },

  // 构造装饰器实例并初始化缓存/状态
  initialize: function initialize(paths, options) {
    L$1.FeatureGroup.prototype.initialize.call(this);
    L$1.Util.setOptions(this, options);
    this._map = null;
    this._paths = this._initPaths(paths);
    this._pathBounds = this._initPathBounds();
    this._bounds = this._initBounds();
    this._patterns = this._initPatterns(this.options.patterns);
    this._redrawSeq = 0;
    this._projectedPathCache = {
      zoom: null,
      items: []
    };
    // 增量渲染状态：每个 pattern 对应一个容器组 + 每条 path 的签名与图层
    this._patternGroups = [];
    this._patternLayerState = [];
    // 异步绘制任务序号：每次 redraw 自增，用于取消旧任务
    this._drawTaskId = 0;
    // 异步绘制的 requestAnimFrame 句柄
    this._drawFrame = null;
  },

  // 取消当前异步分帧绘制（在新 redraw 或移除图层时调用）
  _cancelAsyncDraw: function _cancelAsyncDraw() {
    this._drawTaskId += 1;
    if (this._drawFrame && L$1.Util.cancelAnimFrame) {
      L$1.Util.cancelAnimFrame(this._drawFrame);
    }
    this._drawFrame = null;
  },

  /**
   * Deals with all the different cases. input can be one of these types:
   * array of LatLng, array of 2-number arrays, Polyline, Polygon,
   * array of one of the previous.
   */
  // 归一化输入路径：统一转成“坐标数组列表”
  _initPaths: function _initPaths(input, isPolygon) {
    var _this = this;

    if (isCoordArray(input)) {
      // Leaflet Polygons don't need the first point to be repeated, but we do
      var coords = isPolygon ? input.concat([input[0]]) : input;
      return [coords];
    }
    if (input instanceof L$1.Polyline) {
      // we need some recursivity to support multi-poly*
      return this._initPaths(input.getLatLngs(), input instanceof L$1.Polygon);
    }
    if (Array.isArray(input)) {
      // flatten everything, we just need coordinate lists to apply patterns
      return input.reduce(function (flatArray, p) {
        return flatArray.concat(_this._initPaths(p, isPolygon));
      }, []);
    }
    return [];
  },

  // 解析所有 pattern 配置并做预处理
  _initPatterns: function _initPatterns(patternDefs) {
    return patternDefs.map(this._parsePatternDef);
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  // 更新 pattern 配置并触发重绘
  setPatterns: function setPatterns(patterns) {
    this.options.patterns = patterns;
    this._patterns = this._initPatterns(this.options.patterns);
    this._resetPatternGroups();
    this.redraw();
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  setPaths: function setPaths(paths) {
    this._paths = this._initPaths(paths);
    this._pathBounds = this._initPathBounds();
    this._bounds = this._initBounds();
    this._projectedPathCache = {
      zoom: null,
      items: []
    };
    this._clearPatternLayerState();
    this.redraw();
  },

  // 重置每个 pattern 的容器组（用于 setPatterns 后结构变化）
  _resetPatternGroups: function _resetPatternGroups() {
    var _this2 = this;

    this.clearLayers();
    this._patternGroups = this._patterns.map(function () {
      return L$1.featureGroup();
    });
    this._patternLayerState = this._patterns.map(function () {
      return [];
    });
    this._patternGroups.forEach(function (group) {
      return _this2.addLayer(group);
    });
  },

  // 仅清理 path 级缓存状态，保留 pattern 容器结构（用于 setPaths）
  _clearPatternLayerState: function _clearPatternLayerState() {
    this._patternGroups.forEach(function (group) {
      return group.clearLayers();
    });
    this._patternLayerState = this._patterns.map(function () {
      return [];
    });
  },

  // 确保 pattern 容器组已创建并与当前 pattern 数量一致
  _ensurePatternGroups: function _ensurePatternGroups() {
    if (this._patternGroups.length !== this._patterns.length) {
      this._resetPatternGroups();
    }
  },

  // 计算方向点签名：用于判断某条 path 的符号是否真的变化
  _getDirectionPointsSignature: function _getDirectionPointsSignature(directionPoints) {
    if (!directionPoints.length) {
      return "";
    }
    // 轻量哈希，避免大字符串拼接带来的 GC 压力
    var hash = 2166136261;
    directionPoints.forEach(function (point) {
      var _point$latLng = point.latLng,
          lat = _point$latLng.lat,
          lng = _point$latLng.lng;

      var a = Math.round(lat * 1e6);
      var b = Math.round(lng * 1e6);
      var c = Math.round(point.heading * 1e3);
      hash ^= a;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash ^= b;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      hash ^= c;
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    });
    return directionPoints.length + ":" + (hash >>> 0);
  },

  // 统一计时入口，优先使用高精度 performance.now
  _now: function _now() {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  },

  // 判断当前 redraw 是否需要输出调试日志
  _shouldDebug: function _shouldDebug() {
    if (!this.options.debugPerformance) {
      return false;
    }
    var every = this.options.debugEveryNRedraws || 1;
    return this._redrawSeq % every === 0;
  },

  // 输出本次 redraw 的性能分项
  _debugLog: function _debugLog(perf) {
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
      slowestPaths: perf.slowestPaths
    });
  },

  // 维护最慢路径列表（按 totalMs 降序）
  _rememberSlowPath: function _rememberSlowPath(perf, pathPerf) {
    if (!this.options.debugPerformance) {
      return;
    }
    perf.slowestPaths.push(pathPerf);
    perf.slowestPaths.sort(function (a, b) {
      return b.totalMs - a.totalMs;
    });
    var topN = this.options.debugTopPaths || 3;
    if (perf.slowestPaths.length > topN) {
      perf.slowestPaths.length = topN;
    }
  },

  /**
   * Parse the pattern definition
   */
  // 解析单个 pattern 配置：将 offset/repeat 等值标准化
  _parsePatternDef: function _parsePatternDef(patternDef, latLngs) {
    return {
      symbolFactory: patternDef.symbol,
      // Parse offset and repeat values, managing the two cases:
      // absolute (in pixels) or relative (in percentage of the polyline length)
      offset: parseRelativeOrAbsoluteValue(patternDef.offset),
      endOffset: parseRelativeOrAbsoluteValue(patternDef.endOffset),
      repeat: parseRelativeOrAbsoluteValue(patternDef.repeat),
      lineOffset: patternDef.lineOffset
    };
  },

  // 图层加入地图时：初始化绘制并绑定地图事件
  onAdd: function onAdd(map) {
    this._map = map;
    this._ensurePatternGroups();
    this._draw();
    this._map.on("moveend", this.redraw, this);
  },

  // 图层移除时：取消异步任务并解绑事件
  onRemove: function onRemove(map) {
    this._cancelAsyncDraw();
    this._map.off("moveend", this.redraw, this);
    this._map = null;
    L$1.FeatureGroup.prototype.onRemove.call(this, map);
  },

  /**
   * As real pattern bounds depends on map zoom and bounds,
   * we just compute the total bounds of all paths decorated by this instance.
   */
  // 计算全部路径的整体地理边界（对外 getBounds 使用）
  _initBounds: function _initBounds() {
    var allPathCoords = this._paths.reduce(function (acc, path) {
      return acc.concat(path);
    }, []);
    return L$1.latLngBounds(allPathCoords);
  },

  // 为每条路径预计算地理边界，用于后续快速可视性过滤
  _initPathBounds: function _initPathBounds() {
    return this._paths.map(function (path) {
      return L$1.latLngBounds(path);
    });
  },

  // 获取路径投影缓存（按 zoom 维度），减少重复 project 与分段计算
  _getProjectedPathData: function _getProjectedPathData(pathIndex, latLngs, perf) {
    var _this3 = this;

    var zoom = this._map.getZoom();
    if (this._projectedPathCache.zoom !== zoom) {
      this._projectedPathCache.zoom = zoom;
      this._projectedPathCache.items = [];
    }

    var cached = this._projectedPathCache.items[pathIndex];
    if (cached) {
      perf.projectionCacheHits += 1;
      return cached;
    }

    perf.projectionCacheMisses += 1;
    var pathAsPoints = latLngs.map(function (latLng) {
      return _this3._map.project(latLng);
    });
    var data = {
      points: pathAsPoints,
      segments: pointsToSegments(pathAsPoints)
    };
    this._projectedPathCache.items[pathIndex] = data;
    return data;
  },

  // 返回装饰器整体边界
  getBounds: function getBounds() {
    return this._bounds;
  },

  /**
   * Returns an array of ILayers object
   */
  // 根据方向点批量构建符号图层
  _buildSymbols: function _buildSymbols(latLngs, symbolFactory, directionPoints) {
    var _this4 = this;

    return directionPoints.map(function (directionPoint, i) {
      return symbolFactory.buildSymbol(directionPoint, latLngs, _this4._map, i, directionPoints.length);
    });
  },

  /**
   * Compute pairs of LatLng and heading angle,
   * that define positions and directions of the symbols on the path
   */
  // 计算某条路径上符号应放置的方向点（位置 + 朝向）
  _getDirectionPoints: function _getDirectionPoints(latLngs, pattern, pathIndex, perf) {
    var _this5 = this;

    if (latLngs.length < 2) {
      return [];
    }

    var projectedPath = this._getProjectedPathData(pathIndex, latLngs, perf);
    var segments = projectedPath.segments;


    var range = null;
    if (this.options.viewportOnly) {
      // 仅计算可视区（含 padding）对应的路径距离范围
      var pixelBounds = padPixelBounds(L$1, this._map.getPixelBounds(), this.options.viewportPadding);
      range = getVisiblePathDistanceRange(segments, pixelBounds);
      if (!range) {
        return [];
      }
    }

    return projectPatternOnPointPath(segments, pattern, range).map(function (point) {
      return {
        latLng: _this5._map.unproject(L$1.point(point.pt)),
        heading: point.heading
      };
    });
  },

  // 触发重绘：根据配置选择同步绘制或异步分帧绘制
  redraw: function redraw() {
    if (!this._map) {
      return;
    }

    this._cancelAsyncDraw();

    // redraw 总耗时 = 增量更新 draw（不再全量 clear）
    this._redrawSeq += 1;
    var t0 = this._now();
    var t1 = t0;

    var perf = {
      redraw: this._redrawSeq,
      // 当前 redraw 的绘制模式
      mode: this.options.asyncDraw ? "async" : "sync",
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
      totalMs: 0
    };

    if (this.options.asyncDraw) {
      this._drawAsync(perf, t0);
      return;
    }

    var drawStart = this._now();
    this._draw(perf);
    var drawEnd = this._now();

    perf.drawMs = drawEnd - drawStart;
    perf.activeMs = perf.drawMs;
    perf.asyncFrames = 1;
    perf.totalMs = drawEnd - t0;
    this._debugLog(perf);
  },

  // 更新单条路径在某个 pattern 下的符号图层（增量复用/重建）
  _updateSinglePath: function _updateSinglePath(pattern, patternIndex, pathIndex, paddedMapBounds, visibleMapBounds, zoom, perf) {
    // 单条路径更新：用于同步整批更新，也用于异步分块更新
    var patternGroup = this._patternGroups[patternIndex];
    var layerState = this._patternLayerState[patternIndex];
    var path = this._paths[pathIndex];

    perf.pathsTotal += 1;

    var prevState = layerState[pathIndex];

    // 先做路径级 bounds 粗过滤，离屏路径直接跳过
    var pathBounds = this._pathBounds && this._pathBounds[pathIndex];
    if (pathBounds && !paddedMapBounds.intersects(pathBounds)) {
      perf.pathsSkippedByBounds += 1;
      if (prevState && prevState.layer) {
        patternGroup.removeLayer(prevState.layer);
      }
      layerState[pathIndex] = {
        signature: "",
        layer: null,
        zoom: zoom,
        fullyVisible: false,
        directionPointsCount: 0
      };
      return;
    }

    var isFullyVisible = !!(pathBounds && visibleMapBounds.contains(pathBounds));

    if (this.options.viewportOnly && this.options.reuseFullyVisibleAtSameZoom && prevState && prevState.layer && prevState.zoom === zoom && prevState.fullyVisible && isFullyVisible) {
      perf.pathsVisible += 1;
      perf.directionPoints += prevState.directionPointsCount || 0;
      return;
    }

    perf.pathsVisible += 1;
    var pathPerf = {
      pathIndex: pathIndex,
      pointCount: path.length,
      directionPoints: 0,
      directionMs: 0,
      symbolMs: 0,
      totalMs: 0
    };

    var directionStart = this._now();
    var directionPoints = this._getDirectionPoints(path, pattern, pathIndex, perf)
    // 点级过滤，确保最终仅保留可视点
    .filter(function (point) {
      return visibleMapBounds.contains(point.latLng);
    });
    var directionEnd = this._now();

    pathPerf.directionPoints = directionPoints.length;
    pathPerf.directionMs = directionEnd - directionStart;
    perf.directionMs += pathPerf.directionMs;
    perf.directionPoints += directionPoints.length;

    var signature = this._getDirectionPointsSignature(directionPoints);
    if (prevState && prevState.signature === signature) {
      layerState[pathIndex] = {
        signature: signature,
        layer: prevState.layer,
        zoom: zoom,
        fullyVisible: isFullyVisible,
        directionPointsCount: directionPoints.length
      };
      pathPerf.totalMs = pathPerf.directionMs;
      this._rememberSlowPath(perf, {
        pathIndex: pathPerf.pathIndex,
        pointCount: pathPerf.pointCount,
        directionPoints: pathPerf.directionPoints,
        directionMs: Math.round(pathPerf.directionMs * 100) / 100,
        symbolMs: 0,
        totalMs: Math.round(pathPerf.totalMs * 100) / 100
      });
      return;
    }

    var symbolStart = this._now();
    if (prevState && prevState.layer) {
      patternGroup.removeLayer(prevState.layer);
    }

    var symbolLayer = null;
    if (directionPoints.length > 0) {
      perf.symbolsBuilt += directionPoints.length;
      symbolLayer = L$1.featureGroup(this._buildSymbols(path, pattern.symbolFactory, directionPoints));
      patternGroup.addLayer(symbolLayer);
    }

    layerState[pathIndex] = {
      signature: signature,
      layer: symbolLayer,
      zoom: zoom,
      fullyVisible: isFullyVisible,
      directionPointsCount: directionPoints.length
    };
    var symbolEnd = this._now();

    pathPerf.symbolMs = symbolEnd - symbolStart;
    pathPerf.totalMs = pathPerf.directionMs + pathPerf.symbolMs;
    perf.symbolMs += pathPerf.symbolMs;
    this._rememberSlowPath(perf, {
      pathIndex: pathPerf.pathIndex,
      pointCount: pathPerf.pointCount,
      directionPoints: pathPerf.directionPoints,
      directionMs: Math.round(pathPerf.directionMs * 100) / 100,
      symbolMs: Math.round(pathPerf.symbolMs * 100) / 100,
      totalMs: Math.round(pathPerf.totalMs * 100) / 100
    });
  },

  // 清理多余状态项：当路径数量减少时移除尾部残留图层
  _trimPatternLayerState: function _trimPatternLayerState(patternIndex) {
    var patternGroup = this._patternGroups[patternIndex];
    var layerState = this._patternLayerState[patternIndex];
    for (var i = this._paths.length; i < layerState.length; i += 1) {
      if (layerState[i] && layerState[i].layer) {
        patternGroup.removeLayer(layerState[i].layer);
      }
    }
    layerState.length = this._paths.length;
  },

  /**
   * 增量更新某个 pattern 下所有 path 对应的符号图层
   */
  _updatePatternLayers: function _updatePatternLayers(pattern, patternIndex, perf) {
    var visibleMapBounds = this._map.getBounds();
    var paddedMapBounds = visibleMapBounds.pad(this.options.viewportPadding || 0.1);
    var zoom = this._map.getZoom();
    for (var pathIndex = 0; pathIndex < this._paths.length; pathIndex += 1) {
      this._updateSinglePath(pattern, patternIndex, pathIndex, paddedMapBounds, visibleMapBounds, zoom, perf);
    }
    this._trimPatternLayerState(patternIndex);
  },

  // 异步分帧绘制入口：分块处理路径并在最后汇总性能数据
  _drawAsync: function _drawAsync(perf, t0) {
    var _this6 = this;

    // 异步分帧绘制：降低单帧阻塞，提升拖动/缩放流畅度
    this._ensurePatternGroups();

    var localPerf = perf || {
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
      totalMs: 0
    };

    var visibleMapBounds = this._map.getBounds();
    var paddedMapBounds = visibleMapBounds.pad(this.options.viewportPadding || 0.1);
    var zoom = this._map.getZoom();
    var chunkSize = Math.max(1, this.options.asyncChunkSize || 60);
    var drawStart = this._now();

    var taskId = this._drawTaskId;
    // 采用 (patternIndex, pathIndex) 双指针跨帧推进
    var patternIndex = 0;
    var pathIndex = 0;

    var step = function step() {
      if (!_this6._map || taskId !== _this6._drawTaskId) {
        // 组件已移除或被新任务取代：中止当前任务
        return;
      }

      localPerf.asyncFrames += 1;
      var frameStart = _this6._now();
      var processed = 0;
      // 每帧最多处理 chunkSize 条 path，避免长任务卡住主线程
      while (patternIndex < _this6._patterns.length && processed < chunkSize) {
        var start = _this6._now();
        var pattern = _this6._patterns[patternIndex];
        _this6._updateSinglePath(pattern, patternIndex, pathIndex, paddedMapBounds, visibleMapBounds, zoom, localPerf);
        localPerf.addLayerMs += _this6._now() - start;

        pathIndex += 1;
        processed += 1;

        if (pathIndex >= _this6._paths.length) {
          _this6._trimPatternLayerState(patternIndex);
          patternIndex += 1;
          pathIndex = 0;
        }
      }
      localPerf.activeMs += _this6._now() - frameStart;

      if (patternIndex < _this6._patterns.length) {
        // 未完成：下一帧继续
        _this6._drawFrame = L$1.Util.requestAnimFrame(step, _this6);
        return;
      }

      // 完成：输出本次异步绘制性能统计
      _this6._drawFrame = null;
      var drawEnd = _this6._now();
      localPerf.drawMs = drawEnd - drawStart;
      localPerf.totalMs = drawEnd - t0;
      _this6._debugLog(localPerf);
    };

    this._drawFrame = L$1.Util.requestAnimFrame(step, this);
  },

  /**
   * Draw all patterns
   */
  // 同步绘制入口：一次性遍历所有 pattern 与路径
  _draw: function _draw(perf) {
    var _this7 = this;

    this._ensurePatternGroups();

    var localPerf = perf || {
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
      totalMs: 0
    };

    this._patterns.forEach(function (pattern, patternIndex) {
      var addLayerStart = _this7._now();
      _this7._updatePatternLayers(pattern, patternIndex, localPerf);
      localPerf.addLayerMs += _this7._now() - addLayerStart;
    });
  }
});
/*
 * Allows compact syntax to be used
 */
L$1.polylineDecorator = function (paths, options) {
  // 工厂方法：创建 PolylineDecorator 实例
  return new L$1.PolylineDecorator(paths, options);
};

})));
