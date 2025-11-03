import type { FC } from "react";
import { Navbar } from "react-bulma-components";
import LanguageSwitcher from "./languageSwitcher";
import "./navbar.css";

const SiteNavbar: FC<SiteNavbarProps> = () => {
	return (
		<Navbar className="has-background-success">
			<Navbar.Brand>
				<Navbar.Item renderAs="a" href="/" pr={1} pl={1}>
					<img
						alt="CCASA logo"
						src="https://ccasa.eus/image/layout_set_logo?img_id=1611483"
						className="ml-1"
						style={{ maxHeight: "50px", height: "auto" }}
					/>
				</Navbar.Item>
				<LanguageSwitcher />
			</Navbar.Brand>
		</Navbar>
	);
};

interface SiteNavbarProps {
	toggleSidebarShown: () => void;
}

export default SiteNavbar;
