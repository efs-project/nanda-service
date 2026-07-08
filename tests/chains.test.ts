import { describe, expect, it } from "vitest";

import { EFS_SCHEMA_UIDS, EFS_SEPOLIA } from "../src/config/chains.js";

describe("EFS chain registry", () => {
  it("exposes the frozen Sepolia EFS addresses and schema UIDs", () => {
    expect(EFS_SEPOLIA.chainId).toBe(11155111);
    expect(EFS_SEPOLIA.eas).toBe("0xC2679fBD37d54388Ce493F1DB75320D236e1815e");
    expect(EFS_SEPOLIA.indexer).toBe("0xc4DeaBB482C2FA74690629eEa662efb166BD658a");
    expect(EFS_SEPOLIA.edgeResolver).toBe("0xD6643DB36B20895E3E46aD08cdD4ED4BC1dBB7F1");
    expect(EFS_SEPOLIA.transportsAnchor).toBe(
      "0x936fb4c60e82d645bda043b6b7d6a20643c503d4a86450f0d348383e02878cc3"
    );
    expect(EFS_SCHEMA_UIDS.REDIRECT).toBe(
      "0x5dca2fcc2c39c8629616b175a38c5e71d641b3019a3cb4ca790cc8fd32c9b8e0"
    );
  });
});
