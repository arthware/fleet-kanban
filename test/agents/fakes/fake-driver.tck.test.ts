import { describeDriverTck } from "../tck/driver-tck";
import { createFakeAgentDriver, FAKE_DRIVER_FIXTURES } from "./fake-driver";

describeDriverTck(createFakeAgentDriver(), FAKE_DRIVER_FIXTURES);
