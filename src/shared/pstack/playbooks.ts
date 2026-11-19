import { coordinationBooks } from "./coordination";
import { deliveryBooks } from "./delivery";
import { developmentBooks } from "./development";
import { investigationBooks } from "./investigation";

export const PSTACK_PLAYBOOKS = [...developmentBooks, ...investigationBooks, ...coordinationBooks, ...deliveryBooks];
