"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.HostForwarder = exports.VIEWER_HOST_HEADER = void 0;
const cloudfront = __importStar(require("aws-cdk-lib/aws-cloudfront"));
const constructs_1 = require("constructs");
/** Header carrying the hostname the viewer actually asked for. */
exports.VIEWER_HOST_HEADER = 'x-camstream-viewer-host';
/**
 * Preserves the viewer's Host header for the control plane.
 *
 * The `/api/*` behaviour forwards everything except Host, because API Gateway
 * rejects a request whose Host is not its own. That leaves the session Lambda
 * unable to see which of the distribution's aliases the browser used — and it
 * needs exactly that, since a CloudFront cookie policy is scoped to a specific
 * origin, and one signed for the apex will not validate on www.
 *
 * Copying the value into a custom header before CloudFront rewrites it is the
 * only place the original is still available.
 */
class HostForwarder extends constructs_1.Construct {
    function;
    constructor(scope, id) {
        super(scope, id);
        this.function = new cloudfront.Function(this, 'Function', {
            functionName: 'camstream-host-forwarder',
            comment: 'Preserve the viewer Host header for /api/*',
            runtime: cloudfront.FunctionRuntime.JS_2_0,
            code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.headers.host && request.headers.host.value) {
    request.headers['${exports.VIEWER_HOST_HEADER}'] = { value: request.headers.host.value };
  }
  return request;
}
      `.trim()),
        });
    }
}
exports.HostForwarder = HostForwarder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaG9zdC1mb3J3YXJkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJob3N0LWZvcndhcmRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSx1RUFBeUQ7QUFDekQsMkNBQXVDO0FBRXZDLGtFQUFrRTtBQUNyRCxRQUFBLGtCQUFrQixHQUFHLHlCQUF5QixDQUFDO0FBRTVEOzs7Ozs7Ozs7OztHQVdHO0FBQ0gsTUFBYSxhQUFjLFNBQVEsc0JBQVM7SUFDMUIsUUFBUSxDQUFzQjtJQUU5QyxZQUFZLEtBQWdCLEVBQUUsRUFBVTtRQUN0QyxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsQ0FBQyxDQUFDO1FBRWpCLElBQUksQ0FBQyxRQUFRLEdBQUcsSUFBSSxVQUFVLENBQUMsUUFBUSxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDeEQsWUFBWSxFQUFFLDBCQUEwQjtZQUN4QyxPQUFPLEVBQUUsNENBQTRDO1lBQ3JELE9BQU8sRUFBRSxVQUFVLENBQUMsZUFBZSxDQUFDLE1BQU07WUFDMUMsSUFBSSxFQUFFLFVBQVUsQ0FBQyxZQUFZLENBQUMsVUFBVSxDQUFDOzs7O3VCQUl4QiwwQkFBa0I7Ozs7T0FJbEMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztTQUNWLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQXJCRCxzQ0FxQkMifQ==