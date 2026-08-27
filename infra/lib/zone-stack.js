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
exports.CamStreamZoneStack = void 0;
const aws_cdk_lib_1 = require("aws-cdk-lib");
const route53 = __importStar(require("aws-cdk-lib/aws-route53"));
/**
 * The hosted zone, alone in its own stack.
 *
 * It is deployed first and in isolation because the ACM certificate cannot
 * validate until the registrar delegates to these nameservers — bundling the
 * two would leave the whole stack blocked in CREATE_IN_PROGRESS while a human
 * edits DNS at the registrar.
 *
 * Placed in us-east-1 so the certificate stack can reference it without a
 * cross-region lookup. Route 53 itself is global; the region is immaterial.
 */
class CamStreamZoneStack extends aws_cdk_lib_1.Stack {
    hostedZone;
    constructor(scope, id, props) {
        super(scope, id, props);
        this.hostedZone = new route53.PublicHostedZone(this, 'HostedZone', {
            zoneName: props.config.domainName,
            comment: 'CamStream',
        });
        new aws_cdk_lib_1.CfnOutput(this, 'HostedZoneId', { value: this.hostedZone.hostedZoneId });
        new aws_cdk_lib_1.CfnOutput(this, 'NameServers', {
            description: 'Set these four as the nameservers for the domain at your registrar',
            value: aws_cdk_lib_1.Fn.join(' ', this.hostedZone.hostedZoneNameServers ?? []),
        });
    }
}
exports.CamStreamZoneStack = CamStreamZoneStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiem9uZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInpvbmUtc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUEsNkNBQStEO0FBQy9ELGlFQUFtRDtBQVFuRDs7Ozs7Ozs7OztHQVVHO0FBQ0gsTUFBYSxrQkFBbUIsU0FBUSxtQkFBSztJQUMzQixVQUFVLENBQTJCO0lBRXJELFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBcUI7UUFDN0QsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEIsSUFBSSxDQUFDLFVBQVUsR0FBRyxJQUFJLE9BQU8sQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQ2pFLFFBQVEsRUFBRSxLQUFLLENBQUMsTUFBTSxDQUFDLFVBQVU7WUFDakMsT0FBTyxFQUFFLFdBQVc7U0FDckIsQ0FBQyxDQUFDO1FBRUgsSUFBSSx1QkFBUyxDQUFDLElBQUksRUFBRSxjQUFjLEVBQUUsRUFBRSxLQUFLLEVBQUUsSUFBSSxDQUFDLFVBQVUsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxDQUFDO1FBQzdFLElBQUksdUJBQVMsQ0FBQyxJQUFJLEVBQUUsYUFBYSxFQUFFO1lBQ2pDLFdBQVcsRUFBRSxvRUFBb0U7WUFDakYsS0FBSyxFQUFFLGdCQUFFLENBQUMsSUFBSSxDQUFDLEdBQUcsRUFBRSxJQUFJLENBQUMsVUFBVSxDQUFDLHFCQUFxQixJQUFJLEVBQUUsQ0FBQztTQUNqRSxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFqQkQsZ0RBaUJDIn0=