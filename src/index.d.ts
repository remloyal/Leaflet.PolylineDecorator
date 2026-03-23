declare module "leaflet" {
  namespace Symbol {
    interface DashOptions {
      pixelSize?: number | undefined;
      pathOptions?: PathOptions | undefined;
    }

    class Dash {
      constructor(options?: DashOptions);
      initialize(options?: DashOptions): void;
      buildSymbol(
        dirPoint: Point,
        latLngs: LatLng[],
        map: Map,
        index: number,
        total: number,
      ): Polyline;
    }

    function dash(options?: DashOptions): Dash;

    interface ArrowHeadOptions {
      polygon?: boolean | undefined;
      pixelSize?: number | undefined;
      headAngle?: number | undefined;
      angleCorrection?: number | undefined;
      pathOptions?: PathOptions | undefined;
    }

    class ArrowHead {
      constructor(options?: ArrowHeadOptions);
      initialize(options?: ArrowHeadOptions): void;
      buildSymbol(
        dirPoint: Point,
        latLngs: LatLng[],
        map: Map,
        index: number,
        total: number,
      ): Polygon | Polyline;
    }

    function arrowHead(options?: ArrowHeadOptions): ArrowHead;

    interface MarkerOptions {
      rotate?: boolean | undefined;
      markerOptions?: L.MarkerOptions | undefined;
    }

    class Marker {
      constructor(options?: MarkerOptions);
      initialize(options?: MarkerOptions): void;
      buildSymbol(
        dirPoint: Point,
        latLngs: LatLng[],
        map: Map,
        index: number,
        total: number,
      ): L.Marker;
    }

    function marker(options?: MarkerOptions): Marker;
  }

  function isCoord(c: any): boolean;
  function isCoordArray(c: any): boolean;

  interface Pattern {
    offset?: number | string | undefined;
    endOffset?: number | string | undefined;
    repeat: number | string;
    lineOffset?: number | undefined;
    symbol: Symbol.Dash | Symbol.ArrowHead | Symbol.Marker;
  }

  interface PolylineDecoratorOptions {
    patterns: Pattern[];
    /**
     * 性能优化：仅在当前可视区范围内计算/生成符号。
     * 默认为 true（展示效果不变，但大幅减少离屏计算）。
     */
    viewportOnly?: boolean | undefined;
    /**
     * 可视区额外 padding（按屏幕尺寸比例），用于减少平移时边缘符号“跳动”。
     * 默认 0.1。
     */
    viewportPadding?: number | undefined;
    /**
     * 调试：是否打印性能日志。
     */
    debugPerformance?: boolean | undefined;
    /**
     * 调试：每 N 次 redraw 打印一次日志，默认 1。
     */
    debugEveryNRedraws?: number | undefined;
    /**
     * 调试：打印最慢的前 N 条可视路径。
     */
    debugTopPaths?: number | undefined;
    /**
     * 性能优化：当路径在当前视口完整可见且 zoom 不变时，复用上一帧符号图层。
     * 默认 true。
     */
    reuseFullyVisibleAtSameZoom?: boolean | undefined;
    /**
     * 性能优化：是否启用分帧异步重绘。
     * 默认 false。
     */
    asyncDraw?: boolean | undefined;
    /**
     * 性能优化：首次加入地图时是否强制使用异步分帧重绘。
     * 默认 true。
     */
    asyncInitialDraw?: boolean | undefined;
    /**
     * 性能优化：异步分帧时每帧最多处理的 path 数。
     * 默认 60。
     */
    asyncChunkSize?: number | undefined;
  }

  class PolylineDecorator extends FeatureGroup {
    constructor(
      paths:
        | Polyline
        | Polygon
        | LatLngExpression[]
        | Polyline[]
        | Polygon[]
        | LatLngExpression[][],
      options?: PolylineDecoratorOptions,
    );
    initialize(
      paths:
        | Polyline
        | Polygon
        | LatLngExpression[]
        | Polyline[]
        | Polygon[]
        | LatLngExpression[][],
      options?: PolylineDecoratorOptions,
    ): void;
    setPatterns(patterns: Pattern[]): void;
    setPaths(
      paths:
        | Polyline
        | Polygon
        | LatLngExpression[]
        | Polyline[]
        | Polygon[]
        | LatLngExpression[][],
    ): void;
    onAdd(map: Map): this;
    onRemove(map: Map): this;
    getBounds(): LatLngBounds;
    redraw(): void;
  }

  function polylineDecorator(
    paths: Polyline | Polyline[],
    options?: PolylineDecoratorOptions,
  ): PolylineDecorator;
}
