// The replies a bucket sends when a request is signed for the wrong region.
//
// Some carry the region in the `x-amz-bucket-region` header. Others carry it
// only in the XML body. Half the rows are bodies that must be refused,
// since a region read out of a body becomes a hostname to sign for.
//
// Every reply here was written by hand from documentation and memory. Each
// is still waiting on a capture from a real server. s3.test.ts serves each
// row from the stand-in, so the suite proves the parser agrees with this
// file. Each row records that in `from`.
//
// To replace a row with a real reply, run the live test against a bucket
// outside the credentials' region with refusal bodies recorded, paste the
// reply in as a new row marked captured, and keep the reconstruction beside
// it.
//
// `$REGION` stands for the stand-in's home region and is filled in when the
// reply is served. A region written out in full is one the reply names
// wrongly on purpose.

/** One reply, as it comes off the wire. */
export interface Misdirect {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Where a reply's bytes came from. A reconstruction was written from
 * documentation and memory. A capture was copied off the wire from the named
 * server on the named day.
 */
export type Provenance = "reconstructed" | { captured: string; on: string };

export interface RegionFormat {
  name: string;
  reply: Misdirect;
  /**
   * Whether uno follows it: signs again for the named region and reaches the
   * object. When false, uno hands back the status and keeps every request in
   * the credentials' region.
   */
  follow: boolean;
  /** The stand-in's region, when it differs from HOME_REGION. */
  home?: string;
  /**
   * Where the bytes in `reply` came from. Optional in the type; every row
   * sets it.
   */
  from?: Provenance;
}

const XML = { "content-type": "application/xml" };

/** The RequestId and HostId a real reply carries. */
const IDS = "<RequestId>8H4KZ1N0CJ0V4S9P</RequestId><HostId>0Lp1kQ5rW8xT2</HostId>";

export const REGION_FORMATS: readonly RegionFormat[] = [
  // ------------------------------------------------------------- to follow

  // The common case: us-east-1 credentials against a bucket elsewhere.
  {
    name: "AuthorizationHeaderMalformed, with a Region element",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AuthorizationHeaderMalformed</Code>` +
        `<Message>The authorization header is malformed; the region 'us-east-1' is wrong; ` +
        `expecting '$REGION'</Message><Region>$REGION</Region>${IDS}</Error>`,
    },
  },

  // The region in the Message only.
  {
    name: "AuthorizationHeaderMalformed, region only in the Message",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AuthorizationHeaderMalformed</Code>` +
        `<Message>The authorization header is malformed; the region 'us-east-1' is wrong; ` +
        `expecting '$REGION'</Message>${IDS}</Error>`,
    },
  },

  // The region appears only inside the Endpoint hostname.
  {
    name: "PermanentRedirect, region inside the Endpoint host",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 301,
      headers: XML,
      body:
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>PermanentRedirect</Code>` +
        `<Message>The bucket you are attempting to access must be addressed using the ` +
        `specified endpoint. Please send all future requests to this endpoint.</Message>` +
        `<Endpoint>acme-exports.s3.$REGION.amazonaws.com</Endpoint><Bucket>acme-exports</Bucket>` +
        `${IDS}</Error>`,
    },
  },

  // The older dashed endpoint form.
  {
    name: "PermanentRedirect, the dashed endpoint",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 301,
      headers: XML,
      body:
        `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>PermanentRedirect</Code>` +
        `<Message>The bucket you are attempting to access must be addressed using the ` +
        `specified endpoint.</Message><Endpoint>s3-$REGION.amazonaws.com</Endpoint>${IDS}</Error>`,
    },
  },

  // The header alone.
  {
    name: "the header, with no body at all",
    from: "reconstructed",
    follow: true,
    reply: { status: 301, headers: { "x-amz-bucket-region": "$REGION" } },
  },

  // Header and body disagree. The header wins.
  {
    name: "the header, against a body naming somewhere else",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 400,
      headers: { ...XML, "x-amz-bucket-region": "$REGION" },
      body: `<Error><Code>AuthorizationHeaderMalformed</Code><Region>ap-southeast-2</Region></Error>`,
    },
  },

  // Pretty-printed, namespaced, elements in another order: the same reply.
  {
    name: "a body with a namespace, newlines and its elements reordered",
    from: "reconstructed",
    follow: true,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<Error xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n` +
        `  <Region>$REGION</Region>\n  <Code>AuthorizationHeaderMalformed</Code>\n` +
        `  <Message>The authorization header is malformed</Message>\n</Error>\n`,
    },
  },

  // R2 uses the region `auto`. A region made of letters alone is still a
  // region.
  {
    name: "a region that is a word rather than a place",
    from: "reconstructed",
    follow: true,
    home: "auto",
    reply: {
      status: 400,
      headers: XML,
      body: `<Error><Code>AuthorizationHeaderMalformed</Code><Region>$REGION</Region></Error>`,
    },
  },

  // ------------------------------------------------------------- to refuse

  // The region the request already used. Following it would loop.
  {
    name: "a body naming the region the request already used",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<Error><Code>AuthorizationHeaderMalformed</Code><Message>The authorization header ` +
        `is malformed; the region 'us-east-1' is wrong; expecting 'us-east-1'</Message>` +
        `<Region>us-east-1</Region>${IDS}</Error>`,
    },
  },

  // A 400 that is silent about the region.
  {
    name: "IllegalLocationConstraintException, which names no region",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<Error><Code>IllegalLocationConstraintException</Code><Message>The unspecified ` +
        `location constraint is incompatible for the region specific endpoint this request ` +
        `was sent to.</Message>${IDS}</Error>`,
    },
  },

  // A signature error is refused, even though it quotes a region.
  {
    name: "SignatureDoesNotMatch, which quotes a region in passing",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 403,
      headers: XML,
      body:
        `<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated ` +
        `does not match the signature you provided. Check your key and signing method.</Message>` +
        `<Region>$REGION</Region>${IDS}</Error>`,
    },
  },

  // A region becomes a hostname. These three bodies name a host where a
  // region belongs, and must be refused.
  {
    name: "a Region element holding a host",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body: `<Error><Code>AuthorizationHeaderMalformed</Code><Region>elsewhere.example.com</Region></Error>`,
    },
  },
  {
    name: "a Region element that closes the host and opens a path",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body: `<Error><Code>AuthorizationHeaderMalformed</Code><Region>x.amazonaws.com/../..</Region></Error>`,
    },
  },
  {
    name: "a Message quoting something that is not a region",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<Error><Code>AuthorizationHeaderMalformed</Code><Message>The authorization header is ` +
        `malformed; the region 'us-east-1' is wrong; expecting 'elsewhere.example.com'</Message>` +
        `${IDS}</Error>`,
    },
  },

  // An HTML reply from a proxy or portal, refused whole.
  {
    name: "an HTML page from something in the way",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: { "content-type": "text/html" },
      body:
        `<!DOCTYPE html><html><head><title>400 Bad Request</title></head><body>` +
        `<h1>400 Bad Request</h1><p>Region: $REGION</p></body></html>`,
    },
  },
  {
    name: "a body that stops in the middle of the Region",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body: `<Error><Code>AuthorizationHeaderMalformed</Code><Regi`,
    },
  },
  {
    name: "a reply with no body, and no header either",
    from: "reconstructed",
    follow: false,
    reply: { status: 400, headers: XML },
  },
  // A body larger than uno reads of a refusal, with the region past that
  // limit.
  {
    name: "a megabyte before it gets to the point",
    from: "reconstructed",
    follow: false,
    reply: {
      status: 400,
      headers: XML,
      body:
        `<Error><Code>AuthorizationHeaderMalformed</Code><Message>${"x".repeat(1 << 20)}` +
        `</Message><Region>$REGION</Region></Error>`,
    },
  },
];

/** The region the stand-in's bucket is in by default. */
export const HOME_REGION = "eu-west-1";

/** One reply with `$REGION` filled in. */
export function rendered(reply: Misdirect, region: string): Required<Misdirect> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(reply.headers ?? {})) {
    headers[k] = v.replaceAll("$REGION", region);
  }
  return {
    status: reply.status,
    headers,
    body: (reply.body ?? "").replaceAll("$REGION", region),
  };
}
