const {DataStream} = require('scramjet');
const test = require("tape");
const tTest = (t) => {
    return Object.assign(t, {
        expect: (count) => {
            t.expectCount = count;
        },
        done: () => {
            if (t.expectCount > 0 && t.assertCount !== t.expectCount) {
                t.fail(`Expected ${t.expectCount} assertions, but ${t.assertCount} were run.`);
            }
            t.end();
        },
        equals: t.equal
    });
};

const _path = require('path');
const reporter = ({tests, name}) => {
    const ok = !tests.find(({ok}) => !ok);

    console.error(ok ? "✓" : "✗", name);

    tests.forEach(
        (args) => {
            const {ok, operator, actual, expected, name, error} = args;
            console.error('  ', ok ? "✓" : "✗", `${operator}(${name})`);
            if (error) {
                console.error('   !', error.message);
            }
            if (!ok && actual) {
                console.error('   => actual:', actual, 'expected:', expected);
            }
        }
    );

    return {name, ok};
};

const flattenTests = ({tests, conf: {testOnly, ...conf} = {}, prefix = ''}) => {
    return {
        name: prefix,
        tests: Object.keys(tests)
            .reduce((acc, name) => {
                if (typeof tests[name] === "function" && (!testOnly || name.startsWith("test"))) {
                    const test = tests[name];
                    acc.push({
                        name: `${prefix}/${name}`,
                        conf,
                        async exec(t) {
                            try {
                                await test(tTest(t));
                            } catch(e) {
                                t.fail(e.stack.replace(/\n /g, '\n   '));
                                t.done();
                            }
                        }
                    });

                    return acc;
                } else if (typeof tests[name] === "object") {
                    return acc.concat(flattenTests({tests: tests[name], conf, prefix: prefix + '/' + name}).tests);
                }
                return acc;
            }, [])
    };
};

const runTests = ({name, tests, testTimeout = 5000}) => {
    const harness = test.createHarness();

    let current = null;
    const acc = new DataStream;

    let to;

    harness.createStream({objectMode: true})
        .pipe(new DataStream)
            .each(async (chunk) => {
                switch (chunk.type) {
                    case "test":
                        current = Object.assign({}, chunk, {
                            tests: []
                        });
                        clearTimeout(to);
                        to = setTimeout(() => acc.raise(Object.assign(
                            new Error("Test timeouted or exited without ending")),
                            {chunk}
                        ), testTimeout)
                        break;
                    case "assert":
                        if (!current) {
                            const err = new Error('Test assertions run after the test has completed');
                            err.assertion = chunk;
                            throw err;
                        }
                        current.tests.push(chunk);
                        break;
                    case "end": // eslint-disable-next-line
                        const last = current;
                        current = null;
                        clearTimeout(to);
                        return acc.whenWrote(last);
                }
            })
            .on("end", () => {
                acc.end()
            })
            .resume()
        ;

    DataStream.fromArray(tests)
        .map(async ({name, conf, exec}) => harness(name, conf, exec))
        .catch(e => console.error("Error!", e && e.stack));

    return acc
        .map(reporter)
        .toArray()
        .then((result) => ({
            name,
            result,
            ok: !result.find(({ok}) => !ok)
        }));
};

/**
 * Returns a transform stream that should be fed with file objects and runs tests.
 *
 * @param {Object} conf configuration for tape
 * @returns {DataStream} stream of test results.
 */
module.exports = (stream, conf) => {
    // cleanup environment before running tests.
    delete require.cache["scramjet"];
    delete require.cache["scramjet-core"];

    const safeRequire = (path) => {
        try {
            return require(path);
        } catch(e) {
            return {
                test_require: () => {
                    throw e;
                }
            };
        }
    };

    return DataStream.from(stream)
        .map(({path}) => ({
            prefix: _path.basename(path).replace(/\.js$/, ''),
            conf,
            tests: safeRequire(path)
        }))
        .map(flattenTests)
        .map(runTests)
        .tap()
        .until(
            ({name, ok}) => {
                if (!ok) {
                    throw new Error(`✗ Unit test errors occurred in ${name}`);
                }
                return false;
            }
        );
};

/**
 * Runs test on any {Readable} stream of file.
 *
 * @param {Readable} stream stream of file entries
 * @param {Object} conf
 */
module.exports.from = async (stream, conf) => DataStream.from(stream)
    .use(module.exports, conf)
    .run();

module.exports.flattenTests = flattenTests;
module.exports.runTests = runTests;
