"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveConfig = resolveConfig;
function required(app, key) {
    const value = app.node.tryGetContext(key);
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Missing required context value "${key}" in cdk.json`);
    }
    return value;
}
/**
 * Account id, taken from whichever credentials are deploying.
 *
 * Deliberately not committed: it is not a secret, but it is permanent once
 * published and it makes this deployment's bucket names guessable. `cdk`
 * populates CDK_DEFAULT_ACCOUNT from the active profile.
 */
function resolveAccount(app) {
    const fromContext = app.node.tryGetContext('camstream:account');
    if (typeof fromContext === 'string' && fromContext.length > 0) {
        return fromContext;
    }
    const fromEnv = process.env.CDK_DEFAULT_ACCOUNT;
    if (fromEnv) {
        return fromEnv;
    }
    throw new Error('Cannot determine the target AWS account. Run through the cdk CLI with valid ' +
        'credentials, or pass -c camstream:account=<id>.');
}
function resolveConfig(app) {
    const domainName = required(app, 'camstream:domainName');
    const edgeRegion = required(app, 'camstream:edgeRegion');
    if (edgeRegion !== 'us-east-1') {
        throw new Error(`camstream:edgeRegion must be us-east-1 (CloudFront cert requirement), got "${edgeRegion}"`);
    }
    const ttl = app.node.tryGetContext('camstream:segmentTtlDays');
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1) {
        throw new Error('camstream:segmentTtlDays must be an integer >= 1');
    }
    return {
        account: resolveAccount(app),
        primaryRegion: required(app, 'camstream:primaryRegion'),
        edgeRegion,
        domainName,
        // Everything is same-origin on the apex: the player, /api/* and /live/*
        // share one distribution, so CloudFront cookies need no Domain attribute
        // and the player needs no CORS.
        appDomain: domainName,
        altDomains: [`www.${domainName}`],
        segmentTtlDays: ttl,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY29uZmlnLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY29uZmlnLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7O0FBZ0RBLHNDQXlCQztBQXZERCxTQUFTLFFBQVEsQ0FBQyxHQUFRLEVBQUUsR0FBVztJQUNyQyxNQUFNLEtBQUssR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUMxQyxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsTUFBTSxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3BELE1BQU0sSUFBSSxLQUFLLENBQUMsbUNBQW1DLEdBQUcsZUFBZSxDQUFDLENBQUM7SUFDekUsQ0FBQztJQUNELE9BQU8sS0FBSyxDQUFDO0FBQ2YsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILFNBQVMsY0FBYyxDQUFDLEdBQVE7SUFDOUIsTUFBTSxXQUFXLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxhQUFhLENBQUMsbUJBQW1CLENBQUMsQ0FBQztJQUNoRSxJQUFJLE9BQU8sV0FBVyxLQUFLLFFBQVEsSUFBSSxXQUFXLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQzlELE9BQU8sV0FBVyxDQUFDO0lBQ3JCLENBQUM7SUFDRCxNQUFNLE9BQU8sR0FBRyxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQixDQUFDO0lBQ2hELElBQUksT0FBTyxFQUFFLENBQUM7UUFDWixPQUFPLE9BQU8sQ0FBQztJQUNqQixDQUFDO0lBQ0QsTUFBTSxJQUFJLEtBQUssQ0FDYiw4RUFBOEU7UUFDNUUsaURBQWlELENBQ3BELENBQUM7QUFDSixDQUFDO0FBRUQsU0FBZ0IsYUFBYSxDQUFDLEdBQVE7SUFDcEMsTUFBTSxVQUFVLEdBQUcsUUFBUSxDQUFDLEdBQUcsRUFBRSxzQkFBc0IsQ0FBQyxDQUFDO0lBQ3pELE1BQU0sVUFBVSxHQUFHLFFBQVEsQ0FBQyxHQUFHLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztJQUV6RCxJQUFJLFVBQVUsS0FBSyxXQUFXLEVBQUUsQ0FBQztRQUMvQixNQUFNLElBQUksS0FBSyxDQUFDLDhFQUE4RSxVQUFVLEdBQUcsQ0FBQyxDQUFDO0lBQy9HLENBQUM7SUFFRCxNQUFNLEdBQUcsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLGFBQWEsQ0FBQywwQkFBMEIsQ0FBQyxDQUFDO0lBQy9ELElBQUksT0FBTyxHQUFHLEtBQUssUUFBUSxJQUFJLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxHQUFHLENBQUMsSUFBSSxHQUFHLEdBQUcsQ0FBQyxFQUFFLENBQUM7UUFDakUsTUFBTSxJQUFJLEtBQUssQ0FBQyxrREFBa0QsQ0FBQyxDQUFDO0lBQ3RFLENBQUM7SUFFRCxPQUFPO1FBQ0wsT0FBTyxFQUFFLGNBQWMsQ0FBQyxHQUFHLENBQUM7UUFDNUIsYUFBYSxFQUFFLFFBQVEsQ0FBQyxHQUFHLEVBQUUseUJBQXlCLENBQUM7UUFDdkQsVUFBVTtRQUNWLFVBQVU7UUFDVix3RUFBd0U7UUFDeEUseUVBQXlFO1FBQ3pFLGdDQUFnQztRQUNoQyxTQUFTLEVBQUUsVUFBVTtRQUNyQixVQUFVLEVBQUUsQ0FBQyxPQUFPLFVBQVUsRUFBRSxDQUFDO1FBQ2pDLGNBQWMsRUFBRSxHQUFHO0tBQ3BCLENBQUM7QUFDSixDQUFDIn0=