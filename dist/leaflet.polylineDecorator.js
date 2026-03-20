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

var isCoord = function isCoord(c) {
  return c instanceof L$1.LatLng || Array.isArray(c) && c.length === 2 && typeof c[0] === "number";
};

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
    debugTopPaths: 3
  },

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
  },

  /**
   * Deals with all the different cases. input can be one of these types:
   * array of LatLng, array of 2-number arrays, Polyline, Polygon,
   * array of one of the previous.
   */
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

  // parse pattern definitions and precompute some values
  _initPatterns: function _initPatterns(patternDefs) {
    return patternDefs.map(this._parsePatternDef);
  },

  /**
   * Changes the patterns used by this decorator
   * and redraws the new one.
   */
  setPatterns: function setPatterns(patterns) {
    this.options.patterns = patterns;
    this._patterns = this._initPatterns(this.options.patterns);
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
    this.redraw();
  },

  // 统一计时入口，优先使用高精度 performance.now
  _now: function _now() {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }
    return Date.now();
  },

  // 是否应在本次 redraw 输出调试日志
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

  onAdd: function onAdd(map) {
    this._map = map;
    this._draw();
    this._map.on("moveend", this.redraw, this);
  },

  onRemove: function onRemove(map) {
    this._map.off("moveend", this.redraw, this);
    this._map = null;
    L$1.FeatureGroup.prototype.onRemove.call(this, map);
  },

  /**
   * As real pattern bounds depends on map zoom and bounds,
   * we just compute the total bounds of all paths decorated by this instance.
   */
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
    var _this2 = this;

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
      return _this2._map.project(latLng);
    });
    var data = {
      points: pathAsPoints,
      segments: pointsToSegments(pathAsPoints)
    };
    this._projectedPathCache.items[pathIndex] = data;
    return data;
  },

  getBounds: function getBounds() {
    return this._bounds;
  },

  /**
   * Returns an array of ILayers object
   */
  _buildSymbols: function _buildSymbols(latLngs, symbolFactory, directionPoints) {
    var _this3 = this;

    return directionPoints.map(function (directionPoint, i) {
      return symbolFactory.buildSymbol(directionPoint, latLngs, _this3._map, i, directionPoints.length);
    });
  },

  /**
   * Compute pairs of LatLng and heading angle,
   * that define positions and directions of the symbols on the path
   */
  _getDirectionPoints: function _getDirectionPoints(latLngs, pattern, pathIndex, perf) {
    var _this4 = this;

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
        latLng: _this4._map.unproject(L$1.point(point.pt)),
        heading: point.heading
      };
    });
  },

  redraw: function redraw() {
    if (!this._map) {
      return;
    }

    // redraw 总耗时 = clearLayers + draw，细分到 perf 便于定位瓶颈
    this._redrawSeq += 1;
    var t0 = this._now();
    this.clearLayers();
    var t1 = this._now();

    var perf = {
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
      totalMs: 0
    };

    var drawStart = this._now();
    this._draw(perf);
    var drawEnd = this._now();

    perf.drawMs = drawEnd - drawStart;
    perf.totalMs = drawEnd - t0;
    this._debugLog(perf);
  },

  /**
   * Returns all symbols for a given pattern as an array of FeatureGroup
   */
  _getPatternLayers: function _getPatternLayers(pattern, perf) {
    var _this5 = this;

    var mapBounds = this._map.getBounds().pad(this.options.viewportPadding || 0.1);
    var layers = [];

    this._paths.forEach(function (path, pathIndex) {
      perf.pathsTotal += 1;

      // 先做路径级 bounds 粗过滤，离屏路径直接跳过
      var pathBounds = _this5._pathBounds && _this5._pathBounds[pathIndex];
      if (pathBounds && !mapBounds.intersects(pathBounds)) {
        perf.pathsSkippedByBounds += 1;
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

      var directionStart = _this5._now();
      var directionPoints = _this5._getDirectionPoints(path, pattern, pathIndex, perf)
      // 点级过滤，确保最终仅保留可视点
      .filter(function (point) {
        return mapBounds.contains(point.latLng);
      });
      var directionEnd = _this5._now();

      pathPerf.directionPoints = directionPoints.length;
      pathPerf.directionMs = directionEnd - directionStart;
      perf.directionMs += pathPerf.directionMs;
      perf.directionPoints += directionPoints.length;
      perf.symbolsBuilt += directionPoints.length;

      var symbolStart = _this5._now();
      var symbolLayer = L$1.featureGroup(_this5._buildSymbols(path, pattern.symbolFactory, directionPoints));
      var symbolEnd = _this5._now();

      pathPerf.symbolMs = symbolEnd - symbolStart;
      pathPerf.totalMs = pathPerf.directionMs + pathPerf.symbolMs;
      perf.symbolMs += pathPerf.symbolMs;
      _this5._rememberSlowPath(perf, {
        pathIndex: pathPerf.pathIndex,
        pointCount: pathPerf.pointCount,
        directionPoints: pathPerf.directionPoints,
        directionMs: Math.round(pathPerf.directionMs * 100) / 100,
        symbolMs: Math.round(pathPerf.symbolMs * 100) / 100,
        totalMs: Math.round(pathPerf.totalMs * 100) / 100
      });

      layers.push(symbolLayer);
    });

    return layers;
  },

  /**
   * Draw all patterns
   */
  _draw: function _draw(perf) {
    var _this6 = this;

    var localPerf = perf || {
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
      totalMs: 0
    };

    this._patterns.map(function (pattern) {
      return _this6._getPatternLayers(pattern, localPerf);
    }).forEach(function (layers) {
      var addLayerStart = _this6._now();
      _this6.addLayer(L$1.featureGroup(layers));
      localPerf.addLayerMs += _this6._now() - addLayerStart;
    });
  }
});
/*
 * Allows compact syntax to be used
 */
L$1.polylineDecorator = function (paths, options) {
  return new L$1.PolylineDecorator(paths, options);
};

})));
