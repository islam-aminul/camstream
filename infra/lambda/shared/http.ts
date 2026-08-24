import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export function json(statusCode: number, body: unknown, cookies?: string[]): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    ...(cookies && cookies.length > 0 ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

export function fail(statusCode: number, message: string): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error: message });
}
