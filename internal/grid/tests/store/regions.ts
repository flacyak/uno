// The ways a bucket says it is somewhere else.
//
// A request signed for the wrong region is refused, and the refusal carries
// where the bucket actually is. AWS puts it in `x-amz-bucket-region`, and uno
// follows that already. Not every reply has the header: an S3-compatible
// endpoint, an older PermanentRedirect, a proxy that drops headers it does not
// know about, all answer with the region in the XML body and nothing on the
// outside. Without reading the body those buckets are unreachable, because the
// request that fails is the first one uno sends.
//
// The body is also the least trustworthy thing in the exchange. A region read
// out of it becomes a hostname -- `https://<bucket>.s3.<region>.amazonaws.com`
// -- so anything not shaped like a region is a different host to sign for and
// send credentials to. Half the list below is bodies that must not be followed
// for that reason, and they are the half worth keeping.
//
// None of it has been confirmed. Every reply here was written by hand, from
// the documentation and from memory of what AWS, R2 and MinIO answer, and no
// server has been seen sending a single one of them. s3.test.ts serves each
// row from a stand-in that replies with exactly the bytes written below, so
// what the suite proves is that the parser agrees with this file · whether
// this file agrees with S3 is a separate question, and one nothing here can
// ask. Each row carries that admission in `from`, and keeps it until a real
// server has been watched saying it.
//
// Lifting a row takes credentials and a bucket outside the region they are
// signed for. Run the live test with refusal bodies recorded, against such a
// bucket, and it prints the reply S3 actually sent. Paste that in as a new row
// marked captured, naming the server it came off and the day it came off, and
// leave the reconstruction in place beside it: the two disagreeing is the
// finding, and a reconstruction that the parser still has to handle is worth
// keeping either way. Most of the refusing half can never be lifted at all,
// since no cooperating server sends a body pointing at somebody else's host.
//
// `$REGION` stands for where the stand-in says the bucket is, and is filled in
// when the reply is served. A region written out in full is one the reply
// names wrongly on purpose.

/** One reply, as it comes off the wire. */
export interface Misdirect {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Where a reply's bytes came from, which is what decides how much agreeing
 * with them is worth.
 *
 * A reconstruction is written from the documentation and from memory, and no
 * server has been seen sending it: it says what uno's authors believe S3 does.
 * A capture was copied off the wire from the server it names on the day it
 * names, and says what that server did.
 */
export type Provenance = "reconstructed" | { captured: string; on: string };

export interface RegionFormat {
  name: string;
  reply: Misdirect;
  /**
   * Whether uno should follow it: sign again for the region named, reach the
   * object, and remember the bucket is there. Not following means handing the
   * caller the status, having sent no request anywhere it was not already
   * going.
   */
  follow: boolean;
  /** Where the stand-in is, when that is not the usual eu-west-1. */
  home?: string;
  /**
   * Where the bytes in `reply` came from. Optional so that nothing outside
   * this file has to know the field exists, but every row below answers it.
   */
  from?: Provenance;
}

const XML = { "content-type": "application/xml" };

/** The RequestId and HostId every real reply carries, so a parser meets them. */
const IDS = "<RequestId>8H4KZ1N0CJ0V4S9P</RequestId><HostId>0Lp1kQ5rW8xT2</HostId>";

export const REGION_FORMATS: readonly RegionFormat[] = [
  // ------------------------------------------------------------- to follow

  // The common one: us-east-1 credentials against a bucket anywhere else.
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

  // Some endpoints send the sentence without the element beside it.
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

  // No region as such anywhere in it: the region is inside a hostname.
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

  // The endpoint spelled the way it was before 2019.
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

  // The header, which is what AWS is thought to send. 0.1 did open a bucket
  // in another region back when the header was the only channel uno could
  // follow, so something carried the region that day, but 0.1 never looked at
  // a reply and did not record what. The same open succeeds either way now.
  // So this is a reconstruction like the rest. It stays in the list so that
  // reading bodies cannot cost the header path.
  {
    name: "the header, with no body at all",
    from: "reconstructed",
    follow: true,
    reply: { status: 301, headers: { "x-amz-bucket-region": "$REGION" } },
  },

  // Both, disagreeing. The header is the one S3 maintains; the sentence in the
  // body is prose, and prose has been wrong before.
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

  // R2 signs everything as `auto`. A region with no digits and no hyphen in it
  // is still a region, so the check on the shape cannot be tighter than this.
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

  // The region uno already signed for. Following it sends the identical
  // request again, and the identical reply comes back, and so on forever.
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

  // A 400 about something else entirely. There is nowhere to go.
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

  // A bad signature is a bad signature. Sending it somewhere else does not fix
  // it, and retrying quietly hides which key was the wrong one.
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

  // A region becomes a hostname, so a body that gets to choose the region gets
  // to choose where the next request -- signed, with the session token on it
  // -- is sent. These three are the shapes that buy a host.
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

  // A captive portal, a corporate proxy, a load balancer with nothing behind
  // it. None of it is XML, and none of it should take uno anywhere.
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
  // Long enough to be worth not reading all of, and the region is past the end
  // of anything sensible to read.
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

/** Where a format's stand-in says its bucket is. */
export const HOME_REGION = "eu-west-1";

/** One reply with `$REGION` filled in, ready to serve. */
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
