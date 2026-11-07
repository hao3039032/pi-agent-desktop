import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { collectLanAddresses, desktopLanAddressStatus } = await jiti.import("./lan-addresses.ts");

test("collects non-internal IPv4 addresses with their adapter name", () => {
  const addresses = collectLanAddresses({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: null }],
    en0: [
      { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: null },
      { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: null },
    ],
    "vEthernet (Hyper-V)": [{ address: "10.0.0.5", netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: null }],
  });
  assert.deepEqual(addresses, [
    { address: "192.168.1.20", interface: "en0" },
    { address: "10.0.0.5", interface: "vEthernet (Hyper-V)" },
  ]);
});

test("accepts the numeric family Node < 18.18 reported", () => {
  const addresses = collectLanAddresses({
    eth0: [{ address: "172.16.0.2", netmask: "255.255.0.0", family: 4, mac: "aa:aa:aa:aa:aa:aa", internal: false, cidr: null }],
  });
  assert.deepEqual(addresses, [{ address: "172.16.0.2", interface: "eth0" }]);
});

test("the status reports what the running server does, not the stored preference", () => {
  // isListeningBeyondLoopback reads the live process env (the launcher's bind),
  // so the test switches it the same way the packaged server receives it.
  const original = process.env.PI_WEB_HOSTNAME;
  try {
    delete process.env.PI_WEB_HOSTNAME;
    const loopback = desktopLanAddressStatus("127.0.0.1:30141", { PORT: "30141" });
    assert.equal(loopback.lanListening, false);
    assert.equal(loopback.port, 30141);

    process.env.PI_WEB_HOSTNAME = "0.0.0.0";
    const lan = desktopLanAddressStatus("127.0.0.1:41234");
    assert.equal(lan.lanListening, true);
    assert.equal(lan.port, 41234, "the request's own host supplies the port when the env does not");
  } finally {
    if (original === undefined) delete process.env.PI_WEB_HOSTNAME;
    else process.env.PI_WEB_HOSTNAME = original;
  }
});

test("an unusable or missing port is reported as unknown, never guessed", () => {
  assert.equal(desktopLanAddressStatus(null, {}).port, null);
  assert.equal(desktopLanAddressStatus("127.0.0.1", {}).port, null);
  assert.equal(desktopLanAddressStatus("127.0.0.1:notaport", {}).port, null);
  assert.equal(desktopLanAddressStatus("[::1]:30141", {}).port, 30141);
});
