# Changelog

## [0.1.13](https://github.com/rome-os/rome/compare/node-v0.1.12...node-v0.1.13) (2026-11-28)


### Features

* **computer-use:** support async consent auto-resume and post-approval PermissionFlow ([#2874](https://github.com/rome-os/rome/issues/2874)) ([b27400a](https://github.com/rome-os/rome/commit/b27400ae529446655860e525926a6e2699df0972))
* **rome-node:** replace Docker log setup token with timed browser first-run password setup ([#2869](https://github.com/rome-os/rome/issues/2869)) ([4e24729](https://github.com/rome-os/rome/commit/4e247298ed52fe5f969fe14940d8ed06ca096733))


### Bug Fixes

* **computer-use:** polish native permission guide chrome, docking, and macOS 27 UX ([#2851](https://github.com/rome-os/rome/issues/2851)) ([c5d814f](https://github.com/rome-os/rome/commit/c5d814f71742bff63c08085d4f83d67819ec592f))
* **computer-use:** stage Rome Computer Use.app outside Rome.app to prevent macOS TCC split ([#2875](https://github.com/rome-os/rome/issues/2875)) ([c02b70d](https://github.com/rome-os/rome/commit/c02b70dc5ad5ae26c98aac326d7866afbcd38783))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.10

## [0.1.12](https://github.com/rome-os/rome/compare/node-v0.1.11...node-v0.1.12) (2026-11-27)


### Features

* **node-core:** serve window control on full macOS hosts ([#2767](https://github.com/rome-os/rome/issues/2767)) ([6dc564f](https://github.com/rome-os/rome/commit/6dc564ffc96c181f11e33ed24258f1b71f111116))
* **node:** add a macOS Computer Use permission guide ([#2812](https://github.com/rome-os/rome/issues/2812)) ([143ac29](https://github.com/rome-os/rome/commit/143ac29867660a8bd54ed7c49a8298d216c9e43b))
* **node:** add Audit log view to Rome Node Web UI ([#2542](https://github.com/rome-os/rome/issues/2542)) ([2511b5d](https://github.com/rome-os/rome/commit/2511b5d2579a7e5f8ab9c43edc6c0feb309600bb))
* **node:** add lightweight Web UI and Docker image for Rome Node ([#2519](https://github.com/rome-os/rome/issues/2519)) ([044b43a](https://github.com/rome-os/rome/commit/044b43a60f3b17fcdd4c9b9ec6c2bb4ce00e2939))
* **rome-node:** bundle macOS computer-use in node builds ([#2566](https://github.com/rome-os/rome/issues/2566)) ([16ecc98](https://github.com/rome-os/rome/commit/16ecc98dd3f5f2dc879da309f4a9b7bc1ffd4e54))
* **rome-node:** bundle the macOS computer-use helper ([#2792](https://github.com/rome-os/rome/issues/2792)) ([a49c3cb](https://github.com/rome-os/rome/commit/a49c3cbd2542e3df908707f10b9fc577ddf5d282))
* stop refusing shell commands in shared chats ([#2807](https://github.com/rome-os/rome/issues/2807)) ([21b5e58](https://github.com/rome-os/rome/commit/21b5e58cfa82397ba8e4a95e25a9ec05224a9f22))


### Reverts

* remove computer-use macOS helper & Rome Node host (Option 1 - Part 2/2) ([#2700](https://github.com/rome-os/rome/issues/2700)) ([afd09fd](https://github.com/rome-os/rome/commit/afd09fdac09dc8264d9a805d624f5e781b4cf39a))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.9

## [0.1.11](https://github.com/rome-os/rome/compare/node-v0.1.10...node-v0.1.11) (2026-11-15)


### Features

* personal data, device connections, Health sync and the share-location card ([#2165](https://github.com/rome-os/rome/issues/2165)) ([4df16fd](https://github.com/rome-os/rome/commit/4df16fd90efe73b6a81528e17a31ff3ad66d04de))

## [0.1.10](https://github.com/rome-os/rome/compare/node-v0.1.9...node-v0.1.10) (2026-11-11)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.8

## [0.1.9](https://github.com/rome-os/rome/compare/node-v0.1.8...node-v0.1.9) (2026-11-08)


### Bug Fixes

* **rome-node:** run the connect status screen on production React ([#1892](https://github.com/rome-os/rome/issues/1892)) ([904c656](https://github.com/rome-os/rome/commit/904c656cbef2de5e2964dd81b3ea15a10c366632))

## [0.1.8](https://github.com/rome-os/rome/compare/node-v0.1.7...node-v0.1.8) (2026-11-05)


### Features

* **core:** authenticate to Rome Cloud with signer JWTs ([#1718](https://github.com/rome-os/rome/issues/1718)) ([bd455bf](https://github.com/rome-os/rome/commit/bd455bfcfbd91995a40bc03171fce9c39b699648))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.7

## [0.1.7](https://github.com/rome-os/rome/compare/node-v0.1.6...node-v0.1.7) (2026-11-03)


### Features

* **rome-node:** local append-only audit log on hosts ([#1647](https://github.com/rome-os/rome/issues/1647)) ([4e0f59f](https://github.com/rome-os/rome/commit/4e0f59fcd0326cdf3b1f9e4327e7f27e8b0274ba))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.6

## [0.1.6](https://github.com/rome-os/rome/compare/node-v0.1.5...node-v0.1.6) (2026-10-23)


### Features

* let a new chat work in a folder on a connected device ([#1267](https://github.com/rome-os/rome/issues/1267)) ([c327426](https://github.com/rome-os/rome/commit/c3274267262499ebb2a8a9354b962e74c6a00c36))
* **node:** rename and remove devices from the Devices page ([#1286](https://github.com/rome-os/rome/issues/1286)) ([bb3385f](https://github.com/rome-os/rome/commit/bb3385fe2ba53c6ca353973af0c65e5fcf1a8470))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.5

## [0.1.5](https://github.com/rome-os/rome/compare/node-v0.1.4...node-v0.1.5) (2026-10-21)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.4

## [0.1.4](https://github.com/rome-os/rome/compare/node-v0.1.3...node-v0.1.4) (2026-10-16)


### Features

* **node:** record daemon activity and show it in Settings → Devices ([#1032](https://github.com/rome-os/rome/issues/1032)) ([c3e6a8f](https://github.com/rome-os/rome/commit/c3e6a8f7f0c79de276fa43acfabb511b75dfc62c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.3

## [0.1.3](https://github.com/rome-os/rome/compare/node-v0.1.1...node-v0.1.3) (2026-10-10)


### Features

* **node:** send raw bytes between devices and add rome-node cp ([#821](https://github.com/rome-os/rome/issues/821)) ([617a42a](https://github.com/rome-os/rome/commit/617a42abd95dab06e7600ae4e7638dcdb27c5a8c))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.2

## [0.1.1](https://github.com/rome-os/rome/compare/node-v0.1.0...node-v0.1.1) (2026-09-25)


### Features

* **node:** share a WebSocket daemon and show device status in Settings ([#473](https://github.com/rome-os/rome/issues/473)) ([b0cccab](https://github.com/rome-os/rome/commit/b0cccab2336a7d214489d7ab7d1791a4a4bffbaf))
* **node:** support device-code authorization ([#492](https://github.com/rome-os/rome/issues/492)) ([b2a272d](https://github.com/rome-os/rome/commit/b2a272db7a0d033bcc3e9ce3c199475f43fd8433))
* publish rome node ([#481](https://github.com/rome-os/rome/issues/481)) ([ea274dd](https://github.com/rome-os/rome/commit/ea274dd67b7de40c4de4dcee53886c33c0b0a9d5))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @rome-os/node-core bumped to 0.1.1
