// functional re-impl of L.Point.distanceTo,
// with no dependency on Leaflet for easier testing
function pointDistance(ptA, ptB) {
  const x = ptB.x - ptA.x;
  const y = ptB.y - ptA.y;
  return Math.sqrt(x * x + y * y);
}

const computeSegmentHeading = (a, b) =>
  ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90 + 360) % 360;

const asRatioToPathLength = ({ value, isInPixels }, totalPathLength) =>
  isInPixels ? value / totalPathLength : value;

function parseRelativeOrAbsoluteValue(value) {
  if (typeof value === "string" && value.indexOf("%") !== -1) {
    return {
      value: parseFloat(value) / 100,
      isInPixels: false,
    };
  }
  const parsedValue = value ? parseFloat(value) : 0;
  return {
    value: parsedValue,
    isInPixels: parsedValue > 0,
  };
}

const pointsEqual = (a, b) => a.x === b.x && a.y === b.y;

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
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  let t0 = 0;
  let t1 = 1;

  function clip(p, q) {
    if (p === 0) {
      return q >= 0;
    }

    const ratio = q / p;
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

  if (
    !clip(-dx, segment.a.x - bounds.min.x) ||
    !clip(dx, bounds.max.x - segment.a.x) ||
    !clip(-dy, segment.a.y - bounds.min.y) ||
    !clip(dy, bounds.max.y - segment.a.y)
  ) {
    return null;
  }

  const segmentLength = segment.distB - segment.distA;
  return {
    min: segment.distA + segmentLength * t0,
    max: segment.distA + segmentLength * t1,
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

  const size = bounds.getSize
    ? bounds.getSize()
    : { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y };
  const padding = L.point(size.x * ratio, size.y * ratio);
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

  let minDist = Infinity;
  let maxDist = -Infinity;
  for (let i = 0; i < segments.length; i++) {
    const clippedRange = getClippedSegmentDistanceRange(
      segments[i],
      pixelBounds,
    );
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
  return pts.reduce((segments, b, idx, points) => {
    // this test skips same adjacent points
    if (idx > 0 && !pointsEqual(b, points[idx - 1])) {
      const a = points[idx - 1];
      const distA =
        segments.length > 0 ? segments[segments.length - 1].distB : 0;
      const distAB = pointDistance(a, b);
      segments.push({
        a,
        b,
        distA,
        distB: distA + distAB,
        heading: computeSegmentHeading(a, b),
      });
    }
    return segments;
  }, []);
}

function projectPatternOnPointPath(segmentsOrPoints, pattern, range) {
  const hasSegments =
    Array.isArray(segmentsOrPoints) &&
    segmentsOrPoints.length > 0 &&
    typeof segmentsOrPoints[0].distA === "number" &&
    typeof segmentsOrPoints[0].distB === "number";

  const segments = hasSegments
    ? segmentsOrPoints
    : pointsToSegments(segmentsOrPoints);
  const nbSegments = segments.length;
  if (nbSegments === 0) {
    return [];
  }

  const totalPathLength = segments[nbSegments - 1].distB;

  const offset = asRatioToPathLength(pattern.offset, totalPathLength);
  const endOffset = asRatioToPathLength(pattern.endOffset, totalPathLength);
  const repeat = asRatioToPathLength(pattern.repeat, totalPathLength);
  const lineOffset = pattern.lineOffset || 0;

  const repeatIntervalPixels = totalPathLength * repeat;
  const startOffsetPixels = offset > 0 ? totalPathLength * offset : 0;
  const endOffsetPixels = endOffset > 0 ? totalPathLength * endOffset : 0;

  let minOffset = startOffsetPixels;
  let maxOffset = totalPathLength - endOffsetPixels;
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
  const positionOffsets = [];
  if (repeatIntervalPixels > 0) {
    let n = Math.ceil((minOffset - startOffsetPixels) / repeatIntervalPixels);
    if (n < 0) {
      n = 0;
    }
    let positionOffset = startOffsetPixels + n * repeatIntervalPixels;
    while (positionOffset <= maxOffset) {
      positionOffsets.push(positionOffset);
      positionOffset += repeatIntervalPixels;
    }
  } else if (startOffsetPixels >= minOffset && startOffsetPixels <= maxOffset) {
    positionOffsets.push(startOffsetPixels);
  }

  // 3. projects offsets to segments
  let segmentIndex = 0;
  let segment = segments[0];
  return positionOffsets.map((positionOffset) => {
    // find the segment matching the offset,
    // starting from the previous one as offsets are ordered
    while (positionOffset > segment.distB && segmentIndex < nbSegments - 1) {
      segmentIndex++;
      segment = segments[segmentIndex];
    }

    const segmentRatio =
      (positionOffset - segment.distA) / (segment.distB - segment.distA);
    return {
      pt: interpolateBetweenPoints(
        segment.a,
        segment.b,
        segmentRatio,
        lineOffset,
        segment.distB - segment.distA,
      ),
      heading: segment.heading,
    };
  });
}

/**
 * Finds the point which lies on the segment defined by points A and B,
 * at the given ratio of the distance from A to B, by linear interpolation.
 */
function interpolateBetweenPoints(ptA, ptB, ratio, lineOffset = 0, length = 0) {
  let n = { x: 0, y: 0 };
  if (lineOffset !== 0 && length > 0) {
    n = { x: -(ptB.y - ptA.y) / length, y: (ptB.x - ptA.x) / length };
  }

  if (ptB.x !== ptA.x) {
    return {
      x: ptA.x + ratio * (ptB.x - ptA.x) + n.x * lineOffset,
      y: ptA.y + ratio * (ptB.y - ptA.y) + n.y * lineOffset,
    };
  }
  // special case where points lie on the same vertical axis
  return {
    x: ptA.x + n.x * lineOffset,
    y: ptA.y + (ptB.y - ptA.y) * ratio + n.y * lineOffset,
  };
}

export {
  projectPatternOnPointPath,
  pointsToSegments,
  parseRelativeOrAbsoluteValue,
  getClippedSegmentDistanceRange,
  getVisiblePathDistanceRange,
  padPixelBounds,
  // the following function are exported only for unit testing purpose
  computeSegmentHeading,
  asRatioToPathLength,
};
