/* UsageBar for Canvas reports.
 *
 * The SDK bundle (vendor.js) has no source in this repository, so this file is
 * appended to the served vendor.js, as markdown.js is. The bundle's UsageBar
 * throws when its segments sum to more than `total`, and the error replaces
 * the whole Canvas. A total computed apart from its parts can fall short of
 * their sum by a rounding error (a report's float estimate of a byte count was
 * 1 byte below the bytes that arrived), so such a total now draws a full bar.
 * A negative or non-finite value still fails, as in PieChart.
 */
(function () {
  'use strict';

  var modules = globalThis.__zedCanvasModules;
  if (!modules || !modules.react || !modules['@zed/canvas']) return;
  var React = modules.react;
  var sdk = modules['@zed/canvas'];
  var SdkUsageBar = sdk.UsageBar;

  function valid(value) { return Number.isFinite(value) && value >= 0; }

  function UsageBar(props) {
    if (!props.segments.every(function (segment) { return valid(segment.value); }) || (props.total !== undefined && !valid(props.total))) {
      throw new Error('Usage bar values must be finite and non-negative.');
    }
    var sum = props.segments.reduce(function (total, segment) { return total + segment.value; }, 0);
    return React.createElement(SdkUsageBar, props.total !== undefined && props.total < sum ? Object.assign({}, props, { total: sum }) : props);
  }

  // The bundle exports its components as getters, which cannot be reassigned: replace the module object.
  modules['@zed/canvas'] = Object.assign({}, sdk, { UsageBar: UsageBar });
})();
